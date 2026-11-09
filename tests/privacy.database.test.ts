import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { commerceFixture } from './commerce-fixture';
import { PrivacyService } from '../apps/api/src/privacy/privacy.service';
import { InventoryService } from '../apps/api/src/commerce/inventory.service';
import { OrdersService } from '../apps/api/src/commerce/orders.service';
import { AdmissionsService } from '../apps/api/src/commerce/admissions.service';
import { TransfersService } from '../apps/api/src/tickets/transfers.service';
import { AdministrationService } from '../apps/api/src/administration/administration.service';
import { GroupsService } from '../apps/api/src/groups/groups.service';
import { RefundsService } from '../apps/api/src/commerce/refunds.service';
import { decrypt, encrypt } from '../apps/api/src/platform/crypto';
import { JobQueue, type Job } from '../apps/api/src/platform/jobs';
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'complete privacy lifecycle and shared financial rights',
  () => {
    let f: Awaited<ReturnType<typeof commerceFixture>>, privacy: PrivacyService, orders: OrdersService;
    beforeAll(async () => {
      f = await commerceFixture();
      privacy = f.app.get(PrivacyService);
      orders = f.app.get(OrdersService);
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      if (f) await f.close();
    });
    async function remove(user: Awaited<ReturnType<typeof f.actor>>, complete = true) {
      const result = await privacy.request(user.principal, { kind: 'delete', confirmConsequences: true });
      await f.db.transaction((tx) => privacy.handler(tx, { requestId: result.data.id }, result.data.id));
      if (complete) await privacy.erase(result.data.id);
      return result.data;
    }
    async function booking() {
      const buyer = await f.actor(),
        offer = await f.offer();
      const product = await f.app.get(InventoryService).product(f.owner.principal, offer.occurrenceId, {
        name: 'Privacy fixture',
        priceMinor: 2000,
        taxBps: 2200,
        capacity: 20,
        drinks: 1,
        saleStartsAt: new Date(Date.now() - 60000).toISOString(),
        saleEndsAt: offer.ends.toISOString(),
        active: true,
      });
      const held = await orders.hold(
        buyer.principal,
        {
          occurrenceId: offer.occurrenceId,
          email: buyer.email,
          items: [{ productId: product.data.id, quantity: 2 }],
        },
        randomUUID(),
      );
      const payment = await orders.startPayment(buyer.principal, held.data.id, true, {
        useSavedMethods: true,
        saveCard: true,
      });
      await orders.applyPayment(f.provider.sellerValue.id, f.provider.succeed(payment.data.paymentIntentId));
      return { buyer, offer, order: (await orders.view(buyer.principal, held.data.id)).data };
    }
    it('requires consequence confirmation and deduplicates simultaneous requests with one private receipt', async () => {
      const buyer = await f.actor();
      await expect(privacy.request(buyer.principal, { kind: 'delete' })).rejects.toMatchObject({
        code: 'CONFIRM_DELETION',
      });
      const [one, two] = await Promise.all([
        privacy.request(buyer.principal, { kind: 'delete', confirmConsequences: true }),
        privacy.request(buyer.principal, { kind: 'delete', confirmConsequences: true }),
      ]);
      expect(one.data).toEqual(two.data);
      await expect(privacy.receipt({ id: one.data.id, receipt: 'x'.repeat(43) })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      const result = await f.app.inject({
        method: 'POST',
        url: '/v1/privacy/receipt',
        payload: { id: one.data.id, receipt: one.data.receipt },
      });
      expect(result.statusCode).toBe(201);
      expect(result.json().data.status).toBe('pending');
      expect(result.body).not.toContain(buyer.email);
      expect(result.body).not.toContain(buyer.principal.userId);
    });
    it('erases paid customers and provider cards while preserving the ledger and another holder’s admission', async () => {
      const b = await booking(),
        recipient = await f.actor(),
        transfers = f.app.get(TransfersService);
      const invite = await transfers.create(
        b.buyer.principal,
        b.order.tickets[0]!.id,
        { email: recipient.email },
        randomUUID(),
      );
      const row = (
        await f.db.query('SELECT token_encrypted FROM ticket_transfers WHERE id=$1', [invite.data.id])
      ).rows[0]!;
      await transfers.invitation(
        recipient.principal,
        { token: decrypt(row.token_encrypted, f.db.config.APP_ENCRYPTION_KEY), acceptTerms: true },
        true,
      );
      const before = (
        await f.db.query(
          'SELECT p.* FROM ledger_postings p JOIN ledger_journals j ON j.id=p.journal_id WHERE j.order_id=$1 ORDER BY p.id',
          [b.order.id],
        )
      ).rows;
      const receipt = await remove(b.buyer);
      expect((await privacy.receipt({ id: receipt.id, receipt: receipt.receipt })).data.status).toBe(
        'completed',
      );
      expect(
        (
          await f.db.query('SELECT email,display_name,status FROM users WHERE id=$1', [
            b.buyer.principal.userId,
          ])
        ).rows[0]!,
      ).toEqual({ email: null, display_name: '', status: 'deleted' });
      expect(
        (
          await f.db.query('SELECT status,provider_id FROM payment_customers WHERE user_id=$1', [
            b.buyer.principal.userId,
          ])
        ).rows[0]!,
      ).toEqual({ status: 'deleted', provider_id: null });
      expect(
        [...f.provider.customers.values()].filter((c) => c.userId === b.buyer.principal.userId),
      ).toHaveLength(0);
      expect(
        decrypt(
          (await f.db.query('SELECT buyer_email_encrypted FROM orders WHERE id=$1', [b.order.id])).rows[0]!
            .buyer_email_encrypted,
          f.db.config.APP_ENCRYPTION_KEY,
        ),
      ).toBe('');
      expect(
        (
          await f.db.query(
            'SELECT p.* FROM ledger_postings p JOIN ledger_journals j ON j.id=p.journal_id WHERE j.order_id=$1 ORDER BY p.id',
            [b.order.id],
          )
        ).rows,
      ).toEqual(before);
      const admission = await f.app
        .get(AdmissionsService)
        .manual(
          f.owner.principal,
          { ticketId: b.order.tickets[0]!.id, reason: 'Verify transferred admission survives deletion' },
          randomUUID(),
        );
      expect(admission.data).toBeDefined();
      await expect(
        f.app
          .get(AdmissionsService)
          .manual(
            f.owner.principal,
            { ticketId: b.order.tickets[1]!.id, reason: 'Deleted personal holder is not admitted' },
            randomUUID(),
          ),
      ).rejects.toThrow();
      await expect(
        f.db.query("UPDATE users SET display_name='Restored by stale request' WHERE id=$1", [
          b.buyer.principal.userId,
        ]),
      ).rejects.toThrow('Deleted profiles');
      await expect(
        f.db.query('INSERT INTO user_preferences(user_id) VALUES($1)', [b.buyer.principal.userId]),
      ).rejects.toThrow('Personal account');
      await privacy.erase(receipt.id);
      const refunds = f.app.get(RefundsService);
      const refund = await refunds.request(
        f.owner.principal,
        b.order.id,
        { ticketIds: [b.order.tickets[1]!.id], reason: 'Seller approved refund after account deletion' },
        randomUUID(),
        true,
      );
      await refunds.process(refund.data.id);
      expect(
        (await f.db.query('SELECT status FROM refunds WHERE id=$1', [refund.data.id])).rows[0]?.status,
      ).toBe('succeeded');
    });
    it('expires exports, prevents deleted-account downloads, and retains only explicitly restricted data until expiry', async () => {
      const user = await f.actor();
      const exported = await privacy.request(user.principal, { kind: 'export' });
      await f.db.transaction((tx) => privacy.handler(tx, { requestId: exported.data.id }, exported.data.id));
      expect((await privacy.export(user.principal, exported.data.id)).data).toHaveProperty('profile');
      await f.db.query("UPDATE privacy_requests SET expires_at=now()-interval '1 second' WHERE id=$1", [
        exported.data.id,
      ]);
      await expect(privacy.export(user.principal, exported.data.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        privacy.hold(user.principal, user.principal.userId, {
          scope: 'profile',
          legalBasis: 'Documented court preservation requirement',
          reference: 'case-12345',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const hold = await privacy.hold(f.admin.principal, user.principal.userId, {
        scope: 'profile',
        legalBasis: 'Documented court preservation requirement',
        reference: 'case-12345',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });
      await remove(user);
      const retained = (
        await f.db.query('SELECT retained_encrypted FROM privacy_holds WHERE id=$1', [hold.data.id])
      ).rows[0]!;
      expect(decrypt(retained.retained_encrypted, f.db.config.APP_ENCRYPTION_KEY)).toMatchObject({
        email: user.email,
      });
      await expect(
        privacy.retained(user.principal, hold.data.id, {
          reason: 'Attempting forbidden retained record access',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(
        (
          await privacy.retained(f.admin.principal, hold.data.id, {
            reason: 'Authorized disclosure for the recorded legal case',
          })
        ).data,
      ).toMatchObject({ email: user.email });
      expect(
        (await f.db.query('SELECT result_encrypted FROM privacy_requests WHERE id=$1', [exported.data.id]))
          .rows[0]!.result_encrypted,
      ).toBeNull();
      await f.db.query(
        "UPDATE privacy_holds SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",
        [hold.data.id],
      );
      await privacy.maintenance();
      await expect(
        privacy.retained(f.admin.principal, hold.data.id, {
          reason: 'Expired restriction cannot disclose retained data',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(
        (
          await f.db.query('SELECT retained_encrypted,erased_at FROM privacy_holds WHERE id=$1', [
            hold.data.id,
          ])
        ).rows[0]!,
      ).toMatchObject({ retained_encrypted: null, erased_at: expect.any(Date) });
    });
    it('does not report completion after Apple revocation failure and supports an audited operator retry', async () => {
      const user = await f.actor(),
        revoke = vi
          .fn()
          .mockRejectedValueOnce(new Error('provider unavailable'))
          .mockResolvedValue(undefined);
      const service = new PrivacyService(f.db, f.db.config, {
        erasePayments: async () => {},
        revokeApple: revoke,
        eraseMedia: async () => {},
      });
      const request = await remove(user, false);
      const queue = new JobQueue(f.db, {}, { 'privacy.erase': async () => service.erase(request.id) });
      const job = (
        await f.db.query(
          "UPDATE outbox_jobs SET status='processing',lease_token=$1,lease_until=now()+interval '30 seconds',attempts=1,max_attempts=1 WHERE topic='privacy.erase' AND dedupe_key=$2 RETURNING *",
          [randomUUID(), request.id],
        )
      ).rows[0]!;
      await queue.execute(job as Job);
      await service.maintenance();
      expect((await service.receipt({ id: request.id, receipt: request.receipt })).data.status).toBe(
        'review-required',
      );
      expect(
        (await f.db.query('SELECT status FROM users WHERE id=$1', [user.principal.userId])).rows[0]!.status,
      ).toBe('deletion-pending');
      await expect(
        service.retry(user.principal, request.id, {
          expectedVersion: 1,
          reason: 'Provider availability restored',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await service.retry(f.admin.principal, request.id, {
        expectedVersion: 1,
        reason: 'Provider availability restored',
      });
      await f.db.transaction((tx) => service.handler(tx, { requestId: request.id }, randomUUID()));
      await service.erase(request.id);
      expect(revoke).toHaveBeenCalledTimes(2);
      expect((await service.receipt({ id: request.id, receipt: request.receipt })).data.status).toBe(
        'completed',
      );
    });
    it('lets an active member explicitly recover a confirmed group after its owner deletes their account', async () => {
      const owner = await f.actor(),
        member = await f.actor(),
        offer = await f.offer(),
        groups = f.app.get(GroupsService);
      const created = await groups.create(
        owner.principal,
        {
          name: 'Private owner name',
          offerId: offer.offerId,
          expectedVersion: 1,
          guests: 4,
          paymentMode: 'deposit',
          deadline: new Date(Date.now() + 9 * 60000).toISOString(),
          acceptTerms: true,
          acceptBalanceResponsibility: true,
        },
        randomUUID(),
      );
      const invite = await groups.invite(owner.principal, created.data.id, { email: member.email });
      await groups.accept(member.principal, invite.data.token);
      const c = await groups.contribute(
        member.principal,
        created.data.id,
        { amountMinor: 3000, acceptTerms: true },
        randomUUID(),
      );
      const payment = await orders.startPayment(member.principal, c.data.orderId, true);
      await orders.applyPayment(f.provider.sellerValue.id, f.provider.succeed(payment.data.paymentIntentId));
      await groups.reconcile(created.data.id);
      await expect(
        groups.acceptOwnership(member.principal, created.data.id, 'vacant', true),
      ).rejects.toMatchObject({ code: 'OWNER_CHANGED' });
      await f.db.query('INSERT INTO group_messages(id,group_id,author_id,body) VALUES($1,$2,$3,$4)', [
        randomUUID(),
        created.data.id,
        owner.principal.userId,
        'Erase my message',
      ]);
      await remove(owner);
      expect((await groups.view(member.principal, created.data.id)).data.ownerUnavailable).toBe(true);
      const outsider = await f.actor();
      await expect(
        groups.acceptOwnership(outsider.principal, created.data.id, 'vacant', true),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await groups.acceptOwnership(member.principal, created.data.id, 'vacant', true);
      expect((await groups.view(member.principal, created.data.id)).data.ownerId).toBe(
        member.principal.userId,
      );
      expect(
        (
          await f.db.query('SELECT body,status FROM group_messages WHERE author_id=$1', [
            owner.principal.userId,
          ])
        ).rows[0]!,
      ).toEqual({ body: '', status: 'deleted' });
      expect((await orders.view(member.principal, c.data.orderId)).data.status).toBe('paid');
    });
    it('recovers a deleted sole seller owner through administrator review and explicit incoming acceptance', async () => {
      const incoming = await f.actor();
      await remove(f.owner);
      const org = (
        await f.db.query('SELECT version,privacy_sales_paused FROM organizations WHERE id=$1', [f.org])
      ).rows[0]!;
      expect(org.privacy_sales_paused).toBe(true);
      const administration = f.app.get(AdministrationService);
      const transfer = await administration.prepareOwnerTransfer(f.admin.principal, f.org, {
        fromUserId: f.owner.principal.userId,
        toUserId: incoming.principal.userId,
        expectedVersion: org.version,
        reason: 'Verified seller ownership succession after account deletion',
      });
      await administration.acceptOwnership(incoming.principal, transfer.data.id, {
        acceptResponsibilities: true,
      });
      expect(
        (await f.db.query('SELECT privacy_sales_paused FROM organizations WHERE id=$1', [f.org])).rows[0]!
          .privacy_sales_paused,
      ).toBe(false);
    });
  },
);
