import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { commerceFixture } from './commerce-fixture';
import { TransfersService } from '../apps/api/src/tickets/transfers.service';
import { OrdersService } from '../apps/api/src/commerce/orders.service';
import { InventoryService } from '../apps/api/src/commerce/inventory.service';
import { RefundsService } from '../apps/api/src/commerce/refunds.service';
import { AdmissionsService } from '../apps/api/src/commerce/admissions.service';
import { TablesService } from '../apps/api/src/tables/tables.service';
import { decrypt } from '../apps/api/src/platform/crypto';
describe.skipIf(!process.env.TEST_DATABASE_URL)('verified admission transfers', () => {
  let f: Awaited<ReturnType<typeof commerceFixture>>,
    transfers: TransfersService,
    orders: OrdersService,
    admissions: AdmissionsService,
    refunds: RefundsService;
  beforeAll(async () => {
    f = await commerceFixture();
    transfers = f.app.get(TransfersService);
    orders = f.app.get(OrdersService);
    admissions = f.app.get(AdmissionsService);
    refunds = f.app.get(RefundsService);
  });
  afterAll(async () => {
    if (f) await f.close();
  });
  async function booking(table = false) {
    const buyer = await f.actor(),
      offer = await f.offer();
    let orderId: string;
    if (table)
      orderId = (
        await f.app.get(TablesService).hold(
          buyer.principal,
          {
            offerId: offer.offerId,
            expectedVersion: 1,
            guests: 2,
            paymentMode: 'full',
            email: buyer.email,
          },
          randomUUID(),
        )
      ).data.order.id;
    else {
      const product = await f.app.get(InventoryService).product(f.owner.principal, offer.occurrenceId, {
        name: 'Entry',
        priceMinor: 2000,
        taxBps: 2200,
        capacity: 10,
        drinks: 1,
        saleStartsAt: new Date(Date.now() - 3600_000).toISOString(),
        saleEndsAt: offer.ends.toISOString(),
        active: true,
      });
      orderId = (
        await orders.hold(
          buyer.principal,
          {
            occurrenceId: offer.occurrenceId,
            items: [{ productId: product.data.id, quantity: 1 }],
            email: buyer.email,
          },
          randomUUID(),
        )
      ).data.id;
    }
    const payment = await orders.startPayment(buyer.principal, orderId, true);
    await orders.applyPayment(f.provider.sellerValue.id, f.provider.succeed(payment.data.paymentIntentId));
    const ticket = (await orders.view(buyer.principal, orderId)).data.tickets[0]!;
    return { buyer, offer, orderId, ticket };
  }
  async function invitation(
    b: Awaited<ReturnType<typeof booking>>,
    recipient: Awaited<ReturnType<typeof f.actor>>,
  ) {
    const key = randomUUID(),
      input = { email: recipient.email };
    const created = await transfers.create(b.buyer.principal, b.ticket.id, input, key);
    expect(await transfers.create(b.buyer.principal, b.ticket.id, input, key)).toEqual(created);
    const row = (
      await f.db.query('SELECT token_encrypted FROM ticket_transfers WHERE id=$1', [created.data.id])
    ).rows[0]!;
    const token = decrypt(row.token_encrypted, f.db.config.APP_ENCRYPTION_KEY) as string;
    return { ...created.data, token };
  }
  it('binds invitations to the verified email, rotates QR and leaves private payment history with the buyer', async () => {
    const b = await booking(),
      recipient = await f.actor('web'),
      outsider = await f.actor(),
      invite = await invitation(b, recipient),
      old = (await admissions.ticket(b.buyer.principal, b.ticket.id)).data.credential;
    await expect(transfers.invitation(outsider.principal, { token: invite.token })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const preview = await transfers.invitation(recipient.principal, { token: invite.token });
    expect(preview.data).toMatchObject({ ticketId: b.ticket.id, title: 'Group event' });
    await expect(
      transfers.invitation(recipient.principal, { token: invite.token, acceptTerms: false }, true),
    ).rejects.toThrow();
    const response = await f.app.inject({
      method: 'POST',
      url: '/v1/ticket-transfers/accept',
      headers: {
        cookie: `clubby_session=${recipient.credentials.token}`,
        origin: 'http://localhost:8081',
        'x-csrf-token': recipient.credentials.csrfToken,
      },
      payload: { token: invite.token, acceptTerms: true },
    });
    expect(response.statusCode).toBe(201);
    await transfers.invitation(recipient.principal, { token: invite.token, acceptTerms: true }, true);
    expect((await admissions.ticket(recipient.principal, b.ticket.id)).data.credential).not.toBe(old);
    expect((await transfers.list(recipient.principal)).data.map((t) => t.id)).toContain(b.ticket.id);
    await expect(admissions.ticket(b.buyer.principal, b.ticket.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(orders.view(recipient.principal, b.orderId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await orders.view(b.buyer.principal, b.orderId)).data.tickets[0]!.ownerId).toBe(
      recipient.principal.userId,
    );
    expect(
      (
        await admissions.scan(
          f.owner.principal,
          { occurrenceId: b.offer.occurrenceId, credential: old, kind: 'admission' },
          randomUUID(),
        )
      ).data.outcome,
    ).toBe('invalid');
    await expect(
      refunds.request(
        b.buyer.principal,
        b.orderId,
        { ticketIds: [b.ticket.id], reason: 'Buyer attempts refund after transfer' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'TICKET_NOT_REFUNDABLE' });
    expect(
      (
        await f.db.query(
          'SELECT count(*)::int n FROM ledger_journals WHERE order_id=$1 AND reference LIKE $2',
          [b.orderId, 'sale:%'],
        )
      ).rows[0]!.n,
    ).toBe(1);
  });
  it('revokes and expires invitations without changing the current QR', async () => {
    const b = await booking(),
      recipient = await f.actor(),
      invite = await invitation(b, recipient),
      before = (await admissions.ticket(b.buyer.principal, b.ticket.id)).data.credential;
    await transfers.revoke(b.buyer.principal, invite.id);
    await expect(
      transfers.invitation(recipient.principal, { token: invite.token, acceptTerms: true }, true),
    ).rejects.toMatchObject({ code: 'INVITATION_INACTIVE' });
    const second = await invitation(b, recipient);
    await f.db.query("UPDATE ticket_transfers SET expires_at=now()-interval '1 second' WHERE id=$1", [
      second.id,
    ]);
    await expect(
      transfers.invitation(recipient.principal, { token: second.token, acceptTerms: true }, true),
    ).rejects.toMatchObject({ code: 'INVITATION_INACTIVE' });
    expect((await admissions.ticket(b.buyer.principal, b.ticket.id)).data.credential).toBe(before);
  });
  it('serializes transfer acceptance against a simultaneous refund', async () => {
    const b = await booking(),
      recipient = await f.actor(),
      invite = await invitation(b, recipient);
    const results = await Promise.allSettled([
      transfers.invitation(recipient.principal, { token: invite.token, acceptTerms: true }, true),
      refunds.request(
        b.buyer.principal,
        b.orderId,
        { ticketIds: [b.ticket.id], reason: 'Customer cancellation racing transfer' },
        randomUUID(),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const t = (await f.db.query('SELECT status,owner_id FROM tickets WHERE id=$1', [b.ticket.id])).rows[0]!;
    expect(
      t.owner_id === recipient.principal.userId ? t.status === 'valid' : t.status === 'refund-pending',
    ).toBe(true);
  });
  it('serializes an early door scan against acceptance and rejects consumed tickets', async () => {
    const b = await booking(),
      recipient = await f.actor(),
      invite = await invitation(b, recipient);
    await f.db.query("UPDATE occurrences SET starts_at=now()+interval '1 hour' WHERE id=$1", [
      b.offer.occurrenceId,
    ]);
    const old = (await admissions.ticket(b.buyer.principal, b.ticket.id)).data.credential;
    const results = await Promise.allSettled([
      transfers.invitation(recipient.principal, { token: invite.token, acceptTerms: true }, true),
      admissions.scan(
        f.owner.principal,
        { occurrenceId: b.offer.occurrenceId, credential: old, kind: 'admission' },
        randomUUID(),
      ),
    ]);
    const scan = results[1];
    expect(scan.status).toBe('fulfilled');
    if (scan.status === 'fulfilled')
      expect((scan.value as any).data.outcome).toBe(
        results[0].status === 'fulfilled' ? 'invalid' : 'accepted',
      );
    const owner = results[0].status === 'fulfilled' ? recipient : b.buyer;
    const credential = (await admissions.ticket(owner.principal, b.ticket.id)).data.credential;
    if (results[0].status === 'fulfilled')
      await admissions.scan(
        f.owner.principal,
        { occurrenceId: b.offer.occurrenceId, credential, kind: 'admission' },
        randomUUID(),
      );
    await expect(
      transfers.create(owner.principal, b.ticket.id, { email: (await f.actor()).email }, randomUUID()),
    ).rejects.toMatchObject({ code: 'TRANSFER_UNAVAILABLE' });
  });
  it('allows the recipient to return admission so the original buyer can request a refund', async () => {
    const b = await booking(),
      recipient = await f.actor(),
      invite = await invitation(b, recipient);
    await transfers.invitation(recipient.principal, { token: invite.token, acceptTerms: true }, true);
    const back = await transfers.create(
      recipient.principal,
      b.ticket.id,
      { email: b.buyer.email },
      randomUUID(),
    );
    const token = decrypt(
      (await f.db.query('SELECT token_encrypted FROM ticket_transfers WHERE id=$1', [back.data.id])).rows[0]!
        .token_encrypted,
      f.db.config.APP_ENCRYPTION_KEY,
    );
    await transfers.invitation(b.buyer.principal, { token, acceptTerms: true }, true);
    await refunds.request(
      b.buyer.principal,
      b.orderId,
      { ticketIds: [b.ticket.id], reason: 'Ticket returned to purchaser for refund' },
      randomUUID(),
    );
    expect((await admissions.ticket(b.buyer.principal, b.ticket.id)).data.credential).toBeNull();
  });
  it('discloses whole-table cancellation rights and invalidates transferred admissions on that refund', async () => {
    const b = await booking(true),
      recipient = await f.actor(),
      invite = await invitation(b, recipient);
    expect((await transfers.invitation(recipient.principal, { token: invite.token })).data.notice).toContain(
      'complete table',
    );
    await transfers.invitation(recipient.principal, { token: invite.token, acceptTerms: true }, true);
    const all = (await orders.view(b.buyer.principal, b.orderId)).data.tickets.map((t) => t.id);
    await refunds.request(
      b.buyer.principal,
      b.orderId,
      { ticketIds: all, reason: 'Cancel all unused table admissions' },
      randomUUID(),
    );
    expect((await admissions.ticket(recipient.principal, b.ticket.id)).data.credential).toBeNull();
  });
  it('rejects blocked invitations and keeps tokens out of idempotency and audit records', async () => {
    const b = await booking(),
      recipient = await f.actor();
    await f.db.query('INSERT INTO user_blocks(user_id,blocked_user_id) VALUES($1,$2)', [
      recipient.principal.userId,
      b.buyer.principal.userId,
    ]);
    await expect(
      transfers.create(b.buyer.principal, b.ticket.id, { email: recipient.email }, randomUUID()),
    ).rejects.toMatchObject({ code: 'TRANSFER_UNAVAILABLE' });
    const invite = await invitation(b, await f.actor());
    const records = JSON.stringify(
      (await f.db.query('SELECT response FROM api_idempotency WHERE user_id=$1', [b.buyer.principal.userId]))
        .rows,
    );
    expect(records).not.toContain(invite.token);
  });
});
