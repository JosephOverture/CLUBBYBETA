import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { commerceFixture } from './commerce-fixture';
import { walletCertificates, passFiles } from './wallet-certificates';
import { SignedWalletProvider } from '../apps/api/src/tickets/wallet-provider';
import { WalletService } from '../apps/api/src/tickets/wallet.service';
import { TransfersService } from '../apps/api/src/tickets/transfers.service';
import { OrdersService } from '../apps/api/src/commerce/orders.service';
import { InventoryService } from '../apps/api/src/commerce/inventory.service';
import { RefundsService } from '../apps/api/src/commerce/refunds.service';
import { readConfig } from '../apps/api/src/platform/config';
import { decrypt } from '../apps/api/src/platform/crypto';
describe.skipIf(!process.env.TEST_DATABASE_URL)('wallet ownership, download and update authorization', () => {
  let f: Awaited<ReturnType<typeof commerceFixture>>,
    cert: Awaited<ReturnType<typeof walletCertificates>>,
    wallet: WalletService,
    provider: SignedWalletProvider;
  beforeAll(async () => {
    cert = await walletCertificates();
    provider = new SignedWalletProvider(
      readConfig({
        DATABASE_URL: 'postgresql://local:local@127.0.0.1/test',
        APP_ENV: 'test',
        APP_ENCRYPTION_KEY: 'e2'.repeat(32),
        ...cert.env,
      }),
    );
    vi.spyOn(provider, 'googleUpdate').mockResolvedValue();
    vi.spyOn(provider, 'googleSave').mockImplementation(
      async (id) => `https://pay.google.com/gp/v/save/test-${id}`,
    );
    vi.spyOn(provider, 'applePush').mockResolvedValue('sent');
    f = await commerceFixture(cert.env, provider);
    wallet = f.app.get(WalletService);
    await f.db.query("UPDATE venues SET address='10 Example Street, Milan' WHERE id='group-venue'");
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (f) await f.close();
    if (cert) await cert.dispose();
  });
  async function booking() {
    const buyer = await f.actor(),
      offer = await f.offer(),
      orders = f.app.get(OrdersService),
      product = await f.app
        .get(InventoryService)
        .product(f.owner.principal, offer.occurrenceId, {
          name: 'Wallet ticket',
          priceMinor: 1000,
          taxBps: 2200,
          capacity: 10,
          drinks: 1,
          saleStartsAt: new Date(Date.now() - 60_000).toISOString(),
          saleEndsAt: offer.ends.toISOString(),
          active: true,
        });
    const held = await orders.hold(
      buyer.principal,
      {
        occurrenceId: offer.occurrenceId,
        email: buyer.email,
        items: [{ productId: product.data.id, quantity: 1 }],
      },
      randomUUID(),
    );
    const payment = await orders.startPayment(buyer.principal, held.data.id, true);
    await orders.applyPayment(f.provider.sellerValue.id, f.provider.succeed(payment.data.paymentIntentId));
    const ticket = (await orders.view(buyer.principal, held.data.id)).data.tickets[0]!;
    const issued = await wallet.issue(buyer.principal, ticket.id, { wallet: 'apple' }),
      token = issued.data.url.split('/').at(-1)!;
    const p = (await f.db.query('SELECT * FROM wallet_passes WHERE ticket_id=$1', [ticket.id])).rows[0]!;
    return {
      buyer,
      offer,
      orderId: held.data.id,
      ticket,
      token,
      p,
      auth: `ApplePass ${decrypt(p.auth_encrypted, f.db.config.APP_ENCRYPTION_KEY)}`,
    };
  }
  it('issues a one-use session-bound download, permits HEAD, and protects both wallet generation and pass updates', async () => {
    const b = await booking(),
      outsider = await f.actor();
    await expect(wallet.issue(outsider.principal, b.ticket.id, { wallet: 'apple' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const head = await f.app.inject({ method: 'HEAD', url: `/v1/wallet/download/${b.token}` });
    expect(head.statusCode).toBe(200);
    const result = await f.app.inject({ method: 'GET', url: `/v1/wallet/download/${b.token}` });
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toContain('application/vnd.apple.pkpass');
    const pass = JSON.parse(passFiles(result.rawPayload)['pass.json']!.toString());
    expect(pass.serialNumber).toBe(b.p.id);
    await expect(wallet.download(b.token)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(wallet.appleUpdate('pass.test.clubby', b.p.id, 'ApplePass invalid')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(wallet.appleUpdate('pass.another.club', b.p.id, b.auth)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const token = (await wallet.issue(b.buyer.principal, b.ticket.id, { wallet: 'apple' })).data.url
      .split('/')
      .at(-1)!;
    await f.db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [b.buyer.principal.sessionId]);
    await expect(wallet.download(token)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('registers only authorized passes, uses opaque update cursors, and deletes only the requesting registration', async () => {
    const b = await booking(),
      device = 'device_library_test_123',
      other = 'device_library_other_456';
    await expect(
      wallet.register(device, 'pass.test.clubby', b.p.id, undefined, { pushToken: 'aa'.repeat(32) }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(
      await wallet.register(device, 'pass.test.clubby', b.p.id, b.auth, { pushToken: 'aa'.repeat(32) }),
    ).toBe(201);
    expect(
      await wallet.register(device, 'pass.test.clubby', b.p.id, b.auth, { pushToken: 'bb'.repeat(32) }),
    ).toBe(200);
    await wallet.register(other, 'pass.test.clubby', b.p.id, b.auth, { pushToken: 'cc'.repeat(32) });
    const first = await wallet.updates(device, 'pass.test.clubby');
    expect(first?.serialNumbers).toEqual([b.p.id]);
    expect(await wallet.updates(device, 'pass.test.clubby', first!.lastUpdated)).toBeNull();
    await f.db.query('UPDATE tickets SET admitted_at=now() WHERE id=$1', [b.ticket.id]);
    expect((await wallet.updates(device, 'pass.test.clubby', first!.lastUpdated))?.lastUpdated).not.toBe(
      first!.lastUpdated,
    );
    await wallet.unregister(device, 'pass.test.clubby', b.p.id, b.auth);
    expect(await wallet.updates(device, 'pass.test.clubby')).toBeNull();
    expect((await wallet.updates(other, 'pass.test.clubby'))?.serialNumbers).toEqual([b.p.id]);
    expect(
      JSON.stringify(
        (await f.db.query('SELECT * FROM wallet_registrations WHERE pass_id=$1', [b.p.id])).rows,
      ),
    ).not.toContain('cc'.repeat(32));
  });
  it('voids the previous ownership pass without disclosing the new QR, and queues both provider updates durably', async () => {
    const b = await booking(),
      recipient = await f.actor(),
      transfers = f.app.get(TransfersService);
    await wallet.issue(b.buyer.principal, b.ticket.id, { wallet: 'google' });
    const invite = await transfers.create(
        b.buyer.principal,
        b.ticket.id,
        { email: recipient.email },
        randomUUID(),
      ),
      token = decrypt(
        (await f.db.query('SELECT token_encrypted FROM ticket_transfers WHERE id=$1', [invite.data.id]))
          .rows[0]!.token_encrypted,
        f.db.config.APP_ENCRYPTION_KEY,
      );
    const previous = await wallet.projection(b.p.id);
    await transfers.invitation(recipient.principal, { token, acceptTerms: true }, true);
    await expect(wallet.download(b.token)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await wallet.issue(recipient.principal, b.ticket.id, { wallet: 'apple' });
    const passes = (
        await f.db.query('SELECT id FROM wallet_passes WHERE ticket_id=$1 ORDER BY credential_version', [
          b.ticket.id,
        ])
      ).rows,
      newPass = await wallet.projection(passes[1]!.id),
      oldPass = await wallet.projection(b.p.id);
    expect(oldPass).toMatchObject({ active: false, credential: null });
    expect(newPass.active).toBe(true);
    expect(newPass.credential).not.toBe(previous.credential);
    expect(newPass.authToken).not.toBe(previous.authToken);
    const signed = JSON.parse(
      passFiles(await wallet.appleUpdate('pass.test.clubby', b.p.id, b.auth))['pass.json']!.toString(),
    );
    expect(signed.voided).toBe(true);
    expect(JSON.stringify(signed)).not.toContain(newPass.credential!);
    await wallet.maintenance();
    expect(
      (
        await f.db.query("SELECT id FROM outbox_jobs WHERE topic='wallet.sync' AND payload->>'passId'=$1", [
          b.p.id,
        ])
      ).rowCount,
    ).toBe(1);
    await wallet.sync(b.p.id);
    expect(vi.mocked(provider.googleUpdate).mock.calls.at(-1)![0]).toMatchObject({
      id: b.p.id,
      active: false,
      credential: null,
    });
  });
  it('updates schedule and voucher state; refund, dispute and account suspension all invalidate passes', async () => {
    const b = await booking(),
      initial = await wallet.projection(b.p.id);
    await f.db.query(
      "UPDATE occurrences SET starts_at=starts_at+interval '1 hour',ends_at=ends_at+interval '1 hour' WHERE id=$1",
      [b.offer.occurrenceId],
    );
    const updated = await wallet.projection(b.p.id);
    expect(updated.startsAt).not.toBe(initial.startsAt);
    expect(BigInt(updated.revision)).toBeGreaterThan(BigInt(initial.revision));
    await f.db.query('UPDATE tickets SET admitted_at=now() WHERE id=$1', [b.ticket.id]);
    expect((await wallet.projection(b.p.id)).status).toContain('drinks available');
    await f.db.query('UPDATE tickets SET drinks_used=1 WHERE id=$1', [b.ticket.id]);
    expect((await wallet.projection(b.p.id)).active).toBe(false);
    const refundable = await booking();
    await f.app
      .get(RefundsService)
      .request(
        refundable.buyer.principal,
        refundable.orderId,
        { ticketIds: [refundable.ticket.id], reason: 'Customer requested refund of wallet ticket' },
        randomUUID(),
      );
    expect((await wallet.projection(refundable.p.id)).credential).toBeNull();
    const disputed = await booking();
    await f.db.query('UPDATE orders SET dispute_open=true WHERE id=$1', [disputed.orderId]);
    expect((await wallet.projection(disputed.p.id)).active).toBe(false);
    const suspended = await booking();
    await f.db.query("UPDATE users SET status='suspended' WHERE id=$1", [suspended.buyer.principal.userId]);
    expect((await wallet.projection(suspended.p.id)).active).toBe(false);
  });
  it('removes APNs invalid registrations and keeps transient provider failures retryable', async () => {
    const b = await booking(),
      device = 'wallet_push_device_1234';
    await wallet.register(device, 'pass.test.clubby', b.p.id, b.auth, { pushToken: 'dd'.repeat(32) });
    vi.mocked(provider.applePush).mockRejectedValueOnce(new Error('Temporary provider outage'));
    await expect(wallet.sync(b.p.id)).rejects.toThrow('outage');
    expect((await wallet.updates(device, 'pass.test.clubby'))?.serialNumbers).toEqual([b.p.id]);
    vi.mocked(provider.applePush).mockResolvedValueOnce('unregistered');
    await wallet.sync(b.p.id);
    expect(await wallet.updates(device, 'pass.test.clubby')).toBeNull();
  });
});
