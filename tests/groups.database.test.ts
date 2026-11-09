import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { commerceFixture } from './commerce-fixture';
import { GroupsService } from '../apps/api/src/groups/groups.service';
import { ChatService } from '../apps/api/src/groups/chat.service';
import { OrdersService } from '../apps/api/src/commerce/orders.service';
import { RefundsService } from '../apps/api/src/commerce/refunds.service';
import { PaymentsService } from '../apps/api/src/commerce/payments.service';
import { BookingSupportService } from '../apps/api/src/commerce/support.service';
import { AdmissionsService } from '../apps/api/src/commerce/admissions.service';
import { TablesService } from '../apps/api/src/tables/tables.service';
import { groupResponseSchema } from '@clubby/contracts';
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'group funding, contributor refunds and authorized conversations',
  () => {
    let f: Awaited<ReturnType<typeof commerceFixture>>,
      groups: GroupsService,
      chat: ChatService,
      orders: OrdersService,
      refunds: RefundsService;
    beforeAll(async () => {
      f = await commerceFixture();
      groups = f.app.get(GroupsService);
      chat = f.app.get(ChatService);
      orders = f.app.get(OrdersService);
      refunds = f.app.get(RefundsService);
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      if (f) await f.close();
    });
    async function group() {
      const owner = await f.actor(),
        offer = await f.offer(),
        deadline = new Date(Date.now() + 9 * 60_000).toISOString();
      const created = await groups.create(
        owner.principal,
        {
          name: 'Friends at Clubby',
          offerId: offer.offerId,
          expectedVersion: 1,
          guests: 4,
          paymentMode: 'deposit',
          deadline,
          acceptTerms: true,
          acceptBalanceResponsibility: true,
        },
        randomUUID(),
      );
      return { owner, offer, created, id: created.data.id };
    }
    async function join(g: Awaited<ReturnType<typeof group>>, channel: 'ios' | 'web' = 'ios') {
      const member = await f.actor(channel),
        invite = await groups.invite(g.owner.principal, g.id, { email: member.email });
      await groups.accept(member.principal, invite.data.token);
      return member;
    }
    async function pay(
      g: Awaited<ReturnType<typeof group>>,
      member: Awaited<ReturnType<typeof f.actor>>,
      amount: number,
    ) {
      const contribution = await groups.contribute(
        member.principal,
        g.id,
        { amountMinor: amount, acceptTerms: true },
        randomUUID(),
      );
      const payment = await orders.startPayment(member.principal, contribution.data.orderId, true);
      await orders.applyPayment(f.provider.sellerValue.id, f.provider.succeed(payment.data.paymentIntentId));
      return { contribution, payment };
    }
    async function settleRefunds(g: Awaited<ReturnType<typeof group>>) {
      await groups.reconcile(g.id);
      const pending = (
        await f.db.query(
          "SELECT r.id FROM refunds r JOIN group_contributions c ON c.order_id=r.order_id WHERE c.group_id=$1 AND r.status IN ('queued','pending')",
          [g.id],
        )
      ).rows;
      for (const r of pending) {
        await refunds.process(r.id);
        await refunds.refundFee(r.id);
      }
      await groups.reconcile(g.id);
    }
    it('binds expiring single-use invitations to a verified email and enforces membership reads', async () => {
      const g = await group(),
        member = await f.actor(),
        outsider = await f.actor(),
        invitation = await groups.invite(g.owner.principal, g.id, { email: member.email });
      await expect(groups.accept(outsider.principal, invitation.data.token)).rejects.toMatchObject({
        code: 'INVITE_INVALID',
      });
      await groups.accept(member.principal, invitation.data.token);
      await expect(groups.accept(member.principal, invitation.data.token)).rejects.toMatchObject({
        code: 'INVITE_INVALID',
      });
      await expect(groups.view(outsider.principal, g.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const rev = await groups.invite(g.owner.principal, g.id, { email: outsider.email });
      await groups.revokeInvite(g.owner.principal, g.id, rev.data.id);
      await expect(groups.accept(outsider.principal, rev.data.token)).rejects.toMatchObject({
        code: 'INVITE_INVALID',
      });
    });
    it('counts only provider-confirmed unequal contributions and issues one shared allocation without duplicate sales', async () => {
      const g = await group(),
        member = await join(g, 'web');
      await expect(
        orders.startPayment(g.owner.principal, g.created.data.orderId, true),
      ).rejects.toMatchObject({ code: 'GROUP_FUNDING_REQUIRED' });
      await pay(g, g.owner, 1001);
      await groups.reconcile(g.id);
      expect((await groups.view(member.principal, g.id)).data.paidMinor).toBe(1001);
      expect((await orders.view(g.owner.principal, g.created.data.orderId)).data.tickets).toHaveLength(0);
      await pay(g, member, 1999);
      await groups.reconcile(g.id);
      const view = (await groups.view(member.principal, g.id)).data;
      expect(view.state).toBe('confirmed');
      expect(view.tickets).toHaveLength(1);
      expect(view.balanceDueMinor).toBe(7000);
      expect((await orders.view(g.owner.principal, g.created.data.orderId)).data.tickets).toHaveLength(4);
      const money = (
        await f.db.query(
          'SELECT sum(o.commission_minor)::int AS fee,sum(o.total_minor)::int AS amount FROM group_contributions c JOIN orders o ON o.id=c.order_id WHERE c.group_id=$1',
          [g.id],
        )
      ).rows[0]!;
      expect(money).toEqual({ fee: 1250, amount: 3000 });
      expect(
        Number(
          (
            await f.db.query(
              'SELECT sum(o.tax_minor) AS tax FROM group_contributions c JOIN orders o ON o.id=c.order_id WHERE c.group_id=$1',
              [g.id],
            )
          ).rows[0]!.tax,
        ),
      ).toBe((await orders.view(g.owner.principal, g.created.data.orderId)).data.taxMinor);
      expect(
        (
          await f.db.query('SELECT id FROM ledger_journals WHERE reference=$1', [
            `sale:${g.created.data.orderId}`,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await f.db.query('SELECT order_id FROM inventory_reservations WHERE occurrence_id=$1', [
            g.offer.occurrenceId,
          ])
        ).rowCount,
      ).toBe(1);
    });
    it('reserves the final amount across racing web and iOS contributors', async () => {
      const g = await group(),
        a = await join(g, 'web'),
        b = await join(g);
      await pay(g, g.owner, 1000);
      const results = await Promise.allSettled(
        [a, b].map((m) =>
          groups.contribute(m.principal, g.id, { amountMinor: 2000, acceptTerms: true }, randomUUID()),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe(
        'CONTRIBUTION_EXCEEDS_TARGET',
      );
      expect((await groups.view(g.owner.principal, g.id)).data.remainingMinor).toBe(0);
      await groups.reconcile(g.id);
      expect((await groups.view(g.owner.principal, g.id)).data.state).toBe('funding');
    });
    it('refunds every original payer when the complete group is cancelled', async () => {
      const g = await group(),
        member = await join(g),
        a = await pay(g, g.owner, 1200),
        b = await pay(g, member, 1800);
      await groups.reconcile(g.id);
      await groups.cancel(g.owner.principal, g.id, 'Owner cancelled the complete unused group table');
      await settleRefunds(g);
      expect((await groups.view(member.principal, g.id)).data.state).toBe('cancelled');
      const values = [...f.provider.refundValues.values()].filter((r) =>
        [a.payment.data.paymentIntentId, b.payment.data.paymentIntentId].includes(r.paymentId),
      );
      expect(values.map((v) => v.amount).sort()).toEqual([1200, 1800]);
      expect(
        (
          await f.db.query('SELECT status FROM table_allocations WHERE reservation_id=$1', [
            g.created.data.reservationId,
          ])
        ).rows[0]!.status,
      ).toBe('released');
    });
    it('keeps allocation while an expired contribution has an unknown provider outcome, then refunds a late success', async () => {
      const g = await group(),
        pending = await groups.contribute(
          g.owner.principal,
          g.id,
          { amountMinor: 3000, acceptTerms: true },
          randomUUID(),
        ),
        payment = await orders.startPayment(g.owner.principal, pending.data.orderId, true);
      const mocked = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(g.created.data.deadline) + 1000);
      try {
        await groups.reconcile(g.id);
      } finally {
        mocked.mockRestore();
      }
      f.provider.failCancel = true;
      try {
        await expect(orders.expire(pending.data.orderId)).rejects.toThrow('unresolved');
      } finally {
        f.provider.failCancel = false;
      }
      expect(
        (
          await f.db.query('SELECT status FROM table_allocations WHERE reservation_id=$1', [
            g.created.data.reservationId,
          ])
        ).rows[0]!.status,
      ).toBe('held');
      await orders.applyPayment(f.provider.sellerValue.id, f.provider.succeed(payment.data.paymentIntentId));
      await settleRefunds(g);
      expect((await groups.view(g.owner.principal, g.id)).data.state).toBe('expired');
      expect((await orders.view(g.owner.principal, pending.data.orderId)).data.status).toBe('refunded');
    });
    it('reopens funding after an authoritative withdrawal without later cancelling a correctly funded group', async () => {
      const g = await group(),
        member = await join(g),
        first = await pay(g, member, 1000);
      await groups.withdraw(member.principal, g.id, first.contribution.data.id);
      expect((await groups.view(g.owner.principal, g.id)).data.remainingMinor).toBe(2000);
      await settleRefunds(g);
      expect((await groups.view(g.owner.principal, g.id)).data.remainingMinor).toBe(3000);
      await pay(g, g.owner, 3000);
      await groups.reconcile(g.id);
      expect((await groups.view(member.principal, g.id)).data.state).toBe('confirmed');
    });
    it('handles an external partial refund without refunding that amount twice', async () => {
      const g = await group(),
        member = await join(g),
        a = await pay(g, g.owner, 1500);
      await pay(g, member, 1500);
      await groups.reconcile(g.id);
      const external = {
        id: `re_external_${randomUUID()}`,
        paymentId: a.payment.data.paymentIntentId,
        refundId: '',
        amount: 250,
        currency: 'EUR',
        status: 'succeeded',
      };
      f.provider.refundValues.set(external.id, external);
      await f.app.get(PaymentsService).observedRefund(f.provider.sellerValue.id, external);
      const ticket = (await groups.view(member.principal, g.id)).data.tickets[0]!;
      expect(
        (await f.app.get(AdmissionsService).ticket(member.principal, ticket.id)).data.credential,
      ).toBeNull();
      const allocated = await f.app
        .get(BookingSupportService)
        .allocateExternalRefund(f.owner.principal, external.id, {
          ticketIds: [],
          reason: 'Attribute the exact external refund to this contribution',
        });
      await refunds.process(allocated.data.refundId);
      await settleRefunds(g);
      const refunded = (
        await f.db.query(
          "SELECT sum(r.amount_minor)::int AS total FROM refunds r JOIN group_contributions c ON c.order_id=r.order_id WHERE c.group_id=$1 AND r.status='succeeded'",
          [g.id],
        )
      ).rows[0]!.total;
      expect(refunded).toBe(3000);
      expect((await groups.view(g.owner.principal, g.id)).data.state).toBe('cancelled');
    });
    it('returns only the undisputed remainder after a partial lost chargeback', async () => {
      const g = await group(),
        member = await join(g),
        a = await pay(g, g.owner, 1500);
      await pay(g, member, 1500);
      await groups.reconcile(g.id);
      const disputeId = `dp_${randomUUID()}`,
        spy = vi.spyOn(f.provider, 'dispute').mockResolvedValue({
          id: disputeId,
          charge: `ch_${a.payment.data.paymentIntentId}`,
          status: 'lost',
          amount: 600,
          currency: 'eur',
          evidence_details: { due_by: undefined },
        } as unknown as Stripe.Dispute);
      try {
        await f.app.get(PaymentsService).dispute(f.provider.sellerValue.id, disputeId);
      } finally {
        spy.mockRestore();
      }
      await settleRefunds(g);
      expect((await groups.view(g.owner.principal, g.id)).data.state).toBe('cancelled');
      expect(
        (
          await f.db.query(
            "SELECT sum(r.amount_minor)::int AS total FROM refunds r JOIN group_contributions c ON c.order_id=r.order_id WHERE c.group_id=$1 AND r.status='succeeded'",
            [g.id],
          )
        ).rows[0]!.total,
      ).toBe(2400);
      const recovered = vi
        .spyOn(f.provider, 'dispute')
        .mockResolvedValue({
          id: disputeId,
          charge: `ch_${a.payment.data.paymentIntentId}`,
          status: 'won',
          amount: 600,
          currency: 'eur',
          evidence_details: { due_by: undefined },
        } as unknown as Stripe.Dispute);
      try {
        await f.app.get(PaymentsService).dispute(f.provider.sellerValue.id, disputeId);
      } finally {
        recovered.mockRestore();
      }
      await refunds.compensate(a.contribution.data.orderId);
      await settleRefunds(g);
      expect(
        (
          await f.db.query(
            "SELECT sum(r.amount_minor)::int AS total FROM refunds r JOIN group_contributions c ON c.order_id=r.order_id WHERE c.group_id=$1 AND r.status='succeeded'",
            [g.id],
          )
        ).rows[0]!.total,
      ).toBe(3000);
      expect(
        Number(
          (
            await f.db.query(
              "SELECT sum(p.amount_minor) AS amount FROM ledger_journals j JOIN ledger_postings p ON p.journal_id=j.id WHERE j.order_id=$1 AND p.account='provider-collected'",
              [a.contribution.data.orderId],
            )
          ).rows[0]!.amount,
        ),
      ).toBe(0);
    });
    it('requires accepted balance responsibility for ownership and preserves private payment records', async () => {
      const g = await group(),
        member = await join(g);
      await pay(g, g.owner, 1000);
      const transfer = await groups.offerOwnership(g.owner.principal, g.id, member.principal.userId);
      await expect(groups.acceptOwnership(member.principal, g.id, transfer.data.id, false)).rejects.toThrow();
      await groups.acceptOwnership(member.principal, g.id, transfer.data.id, true);
      expect((await groups.view(member.principal, g.id)).data.ownerId).toBe(member.principal.userId);
      await expect(
        groups.cancel(g.owner.principal, g.id, 'Former owner cannot cancel the current booking'),
      ).rejects.toMatchObject({ code: 'GROUP_OWNER_REQUIRED' });
      expect((await groups.view(member.principal, g.id)).data.contributions[0]!.orderId).toBeNull();
    });
    it('orders chat idempotently, recovers missed events and revokes access on departure', async () => {
      const g = await group(),
        member = await join(g),
        key = randomUUID(),
        a = await chat.send(
          member.principal,
          g.id,
          { body: 'I paid in chat, which does not move money.' },
          key,
        ),
        b = await chat.send(
          member.principal,
          g.id,
          { body: 'I paid in chat, which does not move money.' },
          key,
        );
      expect(a).toEqual(b);
      expect((await chat.history(g.owner.principal, g.id, '0')).data).toHaveLength(1);
      expect((await groups.view(g.owner.principal, g.id)).data.paidMinor).toBe(0);
      const events = await chat.events(member.principal, g.id, '0');
      await chat.send(g.owner.principal, g.id, { body: 'A new server-ordered message.' }, randomUUID());
      expect((await chat.events(member.principal, g.id, events.meta.nextCursor)).data).toHaveLength(1);
      await groups.leave(member.principal, g.id, {
        retainConfirmedContribution: false,
        reason: 'Member chose to leave this unfunded group',
      });
      await expect(chat.history(member.principal, g.id, '0')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(chat.events(member.principal, g.id, '0')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
    it('filters blocked chat while preserving financial notices and provides audited moderation', async () => {
      const g = await group(),
        member = await join(g),
        message = await chat.send(
          member.principal,
          g.id,
          { body: 'Reported message in plain text <script>alert(1)</script>' },
          randomUUID(),
        );
      await chat.block(g.owner.principal, member.principal.userId, true);
      expect((await chat.history(g.owner.principal, g.id, '0')).data).toHaveLength(0);
      await pay(g, member, 500);
      expect((await chat.events(g.owner.principal, g.id, '0')).data.some((e) => e.kind === 'payment')).toBe(
        true,
      );
      const report = await chat.report(
        g.owner.principal,
        g.id,
        message.data.id,
        'User reports the content as abusive',
      );
      await expect(
        chat.moderate(member.principal, report.data.id, {
          action: 'hide',
          reason: 'Unauthorized moderator attempt',
        }),
      ).rejects.toMatchObject({ status: 403 });
      await chat.moderate(f.admin.principal, report.data.id, {
        action: 'hide',
        reason: 'Reviewed report and hid the abusive message',
      });
      await chat.block(g.owner.principal, member.principal.userId, false);
      expect((await chat.history(g.owner.principal, g.id, '0')).data).toHaveLength(0);
    });
    it('honors funding recorded before its deadline even if the expiry worker runs late', async () => {
      const g = await group();
      await pay(g, g.owner, 3000);
      const mocked = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(g.created.data.deadline) + 1000);
      try {
        await orders.expire(g.created.data.orderId);
        await groups.reconcile(g.id);
      } finally {
        mocked.mockRestore();
      }
      expect((await groups.view(g.owner.principal, g.id)).data.state).toBe('confirmed');
    });
    it('releases a completely unfunded group after its deadline', async () => {
      const g = await group(),
        mocked = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(g.created.data.deadline) + 1000);
      try {
        await groups.reconcile(g.id);
      } finally {
        mocked.mockRestore();
      }
      expect((await groups.view(g.owner.principal, g.id)).data.state).toBe('expired');
      expect(
        (
          await f.db.query('SELECT status FROM table_allocations WHERE reservation_id=$1', [
            g.created.data.reservationId,
          ])
        ).rows[0]!.status,
      ).toBe('released');
    });
    it('exposes the same typed group through authorized HTTP and rejects another account', async () => {
      const g = await group(),
        outsider = await f.actor();
      const result = await f.app.inject({
        url: `/v1/groups/${g.id}`,
        headers: { authorization: `Bearer ${g.owner.credentials.token}` },
      });
      expect(result.statusCode).toBe(200);
      expect(groupResponseSchema.parse(result.json()).data.id).toBe(g.id);
      expect(
        (
          await f.app.inject({
            url: `/v1/groups/${g.id}`,
            headers: { authorization: `Bearer ${outsider.credentials.token}` },
          })
        ).statusCode,
      ).toBe(404);
      expect((await f.app.inject(`/v1/groups/${g.id}/updates?after=0`)).statusCode).toBe(401);
    });
    it('limits members and expires invitation tokens independently of the client clock', async () => {
      const g = await group();
      await join(g);
      await join(g);
      await join(g);
      const extra = await f.actor(),
        invite = await groups.invite(g.owner.principal, g.id, { email: extra.email });
      await expect(groups.accept(extra.principal, invite.data.token)).rejects.toMatchObject({
        code: 'GROUP_FULL',
      });
      const other = await group(),
        newMember = await f.actor(),
        expires = await groups.invite(other.owner.principal, other.id, { email: newMember.email });
      expect((await groups.previewInvitation(newMember.principal, expires.data.token)).data.name).toBe(
        'Friends at Clubby',
      );
      const mocked = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(other.created.data.deadline) + 1000);
      try {
        await expect(groups.accept(newMember.principal, expires.data.token)).rejects.toMatchObject({
          code: 'INVITE_INVALID',
        });
      } finally {
        mocked.mockRestore();
      }
    });
    it('bounds chat rate and cannot use membership removal to take a funded member’s place', async () => {
      const g = await group(),
        member = await join(g);
      for (let i = 0; i < 20; i++)
        await chat.send(member.principal, g.id, { body: `Message ${i}` }, randomUUID());
      await expect(
        chat.send(member.principal, g.id, { body: 'Beyond rate limit' }, randomUUID()),
      ).rejects.toMatchObject({ code: 'MESSAGE_LIMIT' });
      await pay(g, member, 3000);
      await groups.reconcile(g.id);
      await expect(
        groups.leave(
          g.owner.principal,
          g.id,
          { retainConfirmedContribution: true, reason: 'Owner attempts to remove the paying member' },
          member.principal.userId,
        ),
      ).rejects.toMatchObject({ code: 'CONTRIBUTION_RETAINED' });
      await groups.leave(member.principal, g.id, {
        retainConfirmedContribution: true,
        reason: 'Member retains booking and payment but leaves chat',
      });
      await expect(chat.history(member.principal, g.id, '0')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const ticket = (
        await f.db.query('SELECT ticket_id FROM group_ticket_assignments WHERE group_id=$1 AND user_id=$2', [
          g.id,
          member.principal.userId,
        ])
      ).rows[0]!;
      expect(
        (await f.app.get(AdmissionsService).ticket(member.principal, ticket.ticket_id)).data.status,
      ).toBe('valid');
    });
    it('requires a seller decision for a chargeback after guests already used the booking', async () => {
      const g = await group(),
        member = await join(g),
        a = await pay(g, g.owner, 1500);
      await pay(g, member, 1500);
      await groups.reconcile(g.id);
      await f.app.get(TablesService).collect(
        f.owner.principal,
        g.created.data.reservationId,
        {
          amountMinor: 7000,
          method: 'cash',
          reference: randomUUID(),
          reason: 'Full table balance received from this group',
        },
        randomUUID(),
      );
      const ticket = (await groups.view(member.principal, g.id)).data.tickets[0]!;
      await f.app
        .get(AdmissionsService)
        .manual(
          f.owner.principal,
          { ticketId: ticket.id, reason: 'Guest admitted for the group review scenario' },
          randomUUID(),
        );
      const disputeId = `dp_${randomUUID()}`,
        spy = vi.spyOn(f.provider, 'dispute').mockResolvedValue({
          id: disputeId,
          charge: `ch_${a.payment.data.paymentIntentId}`,
          status: 'lost',
          amount: 1500,
          currency: 'eur',
          evidence_details: { due_by: undefined },
        } as unknown as Stripe.Dispute);
      try {
        await f.app.get(PaymentsService).dispute(f.provider.sellerValue.id, disputeId);
      } finally {
        spy.mockRestore();
      }
      await groups.reconcile(g.id);
      expect((await groups.view(g.owner.principal, g.id)).data.state).toBe('review');
      await expect(
        groups.cancel(g.owner.principal, g.id, 'Owner cannot bypass consumed service financial review'),
      ).rejects.toMatchObject({ code: 'TICKET_NOT_REFUNDABLE' });
      expect((await groups.sellerReviews(f.owner.principal)).data.some((row) => row.id === g.id)).toBe(true);
      await groups.sellerReview(
        f.owner.principal,
        g.id,
        'Seller approved refunding the remaining group contribution after review',
      );
      await settleRefunds(g);
      expect((await groups.view(member.principal, g.id)).data.state).toBe('cancelled');
      expect(
        (
          await f.db.query('SELECT status FROM table_reservations WHERE id=$1', [
            g.created.data.reservationId,
          ])
        ).rows[0]!.status,
      ).toBe('refund-review');
    });
  },
);
