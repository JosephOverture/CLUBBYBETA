import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import type { Principal } from '../identity/identity.service';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import { decrypt } from '../platform/crypto';
import { enqueue } from '../platform/jobs';
import { idempotent, journal, notifyBuyer } from './core';
import { OrdersService } from './orders.service';
import type { PaymentProvider, Refund } from './provider';
import { cancelGroup, groupMoneyChanged } from '../groups/group-events';

export class RefundsService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
    readonly orders: OrdersService,
    readonly provider: PaymentProvider,
  ) {}
  async request(actor: Principal, orderId: string, raw: unknown, key: unknown, staff = false) {
    const input = z
      .object({
        ticketIds: z.array(z.string().uuid()).min(1).max(50),
        reason: z.string().trim().min(10).max(1000),
      })
      .strict()
      .parse(raw);
    input.ticketIds.sort();
    if (new Set(input.ticketIds).size !== input.ticketIds.length)
      throw new ApiError('INVALID_TICKETS', 'Choose each ticket only once.', 400);
    return this.db.transaction((tx) =>
      idempotent(tx, actor.userId, `refund:${orderId}`, key, input, async () => {
        const order = await this.orders.lock(tx, orderId);
        if (staff)
          await this.organizations.authorize(
            actor,
            order.organization_id,
            'booking.refund',
            order.venue_id,
            false,
            tx,
          );
        else this.orders.owner(actor, order);
        if (
          !staff &&
          Date.now() > Date.parse(order.snapshot.startsAt) - order.snapshot.refundCutoffHours * 3600_000
        )
          throw new ApiError(
            'REFUND_CUTOFF',
            'The self-service refund window has closed. Contact booking support.',
            409,
          );
        return { data: await this.queue(tx, order, input.ticketIds, input.reason, actor.userId, false) };
      }),
    );
  }
  async queue(
    tx: PoolClient,
    order: any,
    ticketIds: string[],
    reason: string,
    actorId: string | null,
    automatic: boolean,
    externalAmount?: number,
  ) {
    if (order.payment_role === 'group-reservation') {
      const group = (await tx.query('SELECT * FROM booking_groups WHERE order_id=$1 FOR UPDATE', [order.id]))
        .rows[0];
      if (!group) throw new Error('Group reservation has no group.');
      if (!automatic) {
        const tickets = (
          await tx.query('SELECT id,status,admitted_at,drinks_used FROM tickets WHERE order_id=$1', [
            order.id,
          ])
        ).rows;
        if (
          !tickets.length ||
          tickets.length !== ticketIds.length ||
          tickets.some(
            (t) => !ticketIds.includes(t.id) || t.status !== 'valid' || t.admitted_at || t.drinks_used,
          )
        )
          throw new ApiError('TABLE_REFUND_REQUIRED', 'Refund the entire unused group table.', 409);
      }
      await cancelGroup(tx, group, reason);
      return { id: group.id, status: 'queued', amountMinor: group.target_minor };
    }
    if (!['paid', 'partially-refunded'].includes(order.status) || order.dispute_open)
      throw new ApiError('REFUND_UNAVAILABLE', 'The booking cannot be refunded in its current state.', 409);
    const tickets = (
      await tx.query(
        'SELECT * FROM tickets WHERE order_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
        [order.id, ticketIds],
      )
    ).rows;
    const table = (await tx.query('SELECT id FROM table_reservations WHERE order_id=$1', [order.id])).rows[0];
    if (table) {
      const valid = Number(
        (
          await tx.query("SELECT count(*) AS total FROM tickets WHERE order_id=$1 AND status='valid'", [
            order.id,
          ])
        ).rows[0].total,
      );
      if (ticketIds.length !== valid)
        throw new ApiError(
          'TABLE_REFUND_REQUIRED',
          'A table reservation must be refunded as a whole party.',
          409,
        );
    }
    if (
      tickets.length !== ticketIds.length ||
      tickets.some(
        (t) =>
          t.status !== 'valid' ||
          (!automatic && (t.admitted_at || t.drinks_used > 0 || (!table && t.owner_id !== order.user_id))),
      )
    )
      throw new ApiError(
        'TICKET_NOT_REFUNDABLE',
        'A ticket was used, transferred, already refunded or does not belong to this booking.',
        409,
      );
    const contribution = order.payment_role === 'group-contribution';
    if (contribution && ticketIds.length)
      throw new ApiError('GROUP_WITHDRAW_REQUIRED', 'Use the group contribution withdrawal command.', 409);
    const returned = contribution
      ? (
          await tx.query(
            "SELECT coalesce(sum(amount_minor),0)::int AS amount,coalesce(sum(commission_minor),0)::int AS fee FROM refunds WHERE order_id=$1 AND status='succeeded'",
            [order.id],
          )
        ).rows[0]
      : null;
    const lost = contribution
      ? Number(
          (
            await tx.query(
              "SELECT coalesce(sum(amount_minor),0) AS amount FROM provider_disputes WHERE order_id=$1 AND status='lost'",
              [order.id],
            )
          ).rows[0].amount,
        )
      : 0;
    const remaining = contribution ? order.total_minor - returned.amount - lost : 0;
    if (externalAmount !== undefined && (!contribution || externalAmount < 1 || externalAmount > remaining))
      throw new ApiError('ALLOCATION_MISMATCH', 'External refund exceeds the remaining contribution.', 409);
    const amount = contribution
      ? (externalAmount ?? remaining)
      : tickets.reduce((sum, t) => sum + t.amount_minor, 0);
    const commission = contribution
      ? order.commission_minor - returned.fee
      : order.snapshot.refundCommission
        ? tickets.reduce((sum, t) => sum + t.commission_minor, 0)
        : 0;
    const id = randomUUID();
    await tx.query(
      'INSERT INTO refunds(id,order_id,actor_id,amount_minor,commission_minor,reason) VALUES($1,$2,$3,$4,$5,$6)',
      [id, order.id, actorId, amount, commission, reason],
    );
    for (const ticket of tickets)
      await tx.query('INSERT INTO refund_tickets(refund_id,ticket_id) VALUES($1,$2)', [id, ticket.id]);
    await tx.query("UPDATE tickets SET status='refund-pending' WHERE id=ANY($1::uuid[])", [ticketIds]);
    await tx.query("UPDATE orders SET status='refund-pending',updated_at=now() WHERE id=$1", [order.id]);
    await enqueue(tx, 'refund.process', id, { refundId: id });
    await groupMoneyChanged(tx, order.id, 'refund-requested');
    await audit(tx, actorId, 'refund.request', 'refund', id, reason, {
      orderId: order.id,
      amountMinor: amount,
      ticketIds,
    });
    return { id, status: 'queued', amountMinor: amount };
  }
  async compensate(orderId: string) {
    await this.db.transaction(async (tx) => {
      const order = await this.orders.lock(tx, orderId);
      if (order.payment_role === 'group-reservation') {
        const group = (await tx.query('SELECT * FROM booking_groups WHERE order_id=$1', [orderId])).rows[0];
        await cancelGroup(tx, group, 'The event or table booking was cancelled.');
        return;
      }
      if (order.status === 'refunded') return;
      if (order.status === 'refund-pending' || order.dispute_open)
        throw new Error('Compensation waits for the existing financial workflow.');
      // Review after an anomalous late capture retains stock; normal expiry never releases an unresolved intent.
      if (order.status === 'review') await this.orders.fulfill(tx, order);
      const current = (await tx.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0]!;
      const ids = (
        await tx.query("SELECT id FROM tickets WHERE order_id=$1 AND status='valid' ORDER BY id", [orderId])
      ).rows.map((t) => t.id);
      if (ids.length || current.payment_role === 'group-contribution')
        await this.queue(
          tx,
          current,
          ids,
          'Automatic refund after event cancellation or cancelled checkout',
          null,
          true,
        );
    });
  }
  async process(id: string) {
    const row = (
      await this.db.query(
        'SELECT r.*,a.provider_id AS payment_id,o.account_id,o.currency FROM refunds r JOIN orders o ON o.id=r.order_id LEFT JOIN payment_attempts a ON a.order_id=o.id WHERE r.id=$1',
        [id],
      )
    ).rows[0];
    if (!row || ['succeeded', 'failed'].includes(row.status)) return;
    if (row.amount_minor === 0) {
      await this.complete(row.account_id, {
        id: `free_${id}`,
        status: 'succeeded',
        amount: 0,
        paymentId: '',
        refundId: id,
        currency: row.currency,
      });
      return;
    }
    if (!row.payment_id) throw new Error('Paid refund has no provider payment.');
    let value: Refund;
    if (row.provider_id) value = await this.provider.refund(row.account_id, row.provider_id);
    else {
      if (Date.now() - row.created_at.getTime() > 23 * 3600_000) {
        await this.db.query("UPDATE refunds SET status='review' WHERE id=$1", [id]);
        throw new Error('Refund needs reconciliation beyond idempotency window.');
      }
      // Refund the application fee separately in an exact amount, preserving partial-refund rounding.
      value = await this.provider.createRefund(
        {
          account: row.account_id,
          paymentId: row.payment_id,
          amount: row.amount_minor,
          refundId: id,
          refundCommission: false,
        },
        `refund-${id}`,
      );
    }
    if (row.provider_id === value.id) value = { ...value, refundId: row.id };
    await this.complete(row.account_id, value);
  }
  async complete(account: string, value: Refund) {
    await this.db.transaction(async (tx) => {
      const selected = (await tx.query('SELECT order_id FROM refunds WHERE id=$1', [value.refundId])).rows[0];
      if (!selected) return;
      const order = await this.orders.lock(tx, selected.order_id);
      const row = (
        await tx.query(
          'SELECT r.*,a.provider_id AS payment_id FROM refunds r LEFT JOIN payment_attempts a ON a.order_id=r.order_id WHERE r.id=$1 FOR UPDATE OF r',
          [value.refundId],
        )
      ).rows[0]!;
      if (
        account !== order.account_id ||
        value.amount !== row.amount_minor ||
        value.currency !== order.currency ||
        (row.amount_minor > 0 && value.paymentId !== row.payment_id) ||
        (row.provider_id && value.id !== row.provider_id)
      )
        throw new Error('Refund does not match its immutable request.');
      if (['succeeded', 'failed'].includes(row.status)) return;
      const status =
        value.status === 'succeeded'
          ? 'succeeded'
          : ['failed', 'canceled'].includes(value.status)
            ? 'failed'
            : 'pending';
      await tx.query(
        "UPDATE refunds SET provider_id=$1,status=$2,completed_at=CASE WHEN $2 IN ('succeeded','failed') THEN now() ELSE NULL END WHERE id=$3",
        [value.id, status, row.id],
      );
      if (status === 'pending') return;
      await tx.query(
        `UPDATE tickets SET status=$1 WHERE id IN (SELECT ticket_id FROM refund_tickets WHERE refund_id=$2)`,
        [status === 'succeeded' ? 'refunded' : 'valid', row.id],
      );
      if (status === 'succeeded') {
        // Release only the admissions actually refunded. Serializes with all checkouts on the occurrence.
        const lines = (
          await tx.query(
            'SELECT t.line_id,l.product_id,count(*)::int AS quantity FROM tickets t JOIN refund_tickets rt ON rt.ticket_id=t.id JOIN order_lines l ON l.id=t.line_id WHERE rt.refund_id=$1 GROUP BY t.line_id,l.product_id',
            [row.id],
          )
        ).rows;
        for (const line of lines) {
          const reservation = (
            await tx.query(
              'SELECT quantity FROM inventory_reservations WHERE order_id=$1 AND product_id=$2',
              [order.id, line.product_id],
            )
          ).rows[0]!;
          if (reservation.quantity === line.quantity)
            await tx.query(
              "UPDATE inventory_reservations SET status='released' WHERE order_id=$1 AND product_id=$2",
              [order.id, line.product_id],
            );
          else
            await tx.query(
              'UPDATE inventory_reservations SET quantity=quantity-$1 WHERE order_id=$2 AND product_id=$3',
              [line.quantity, order.id, line.product_id],
            );
        }
        await journal(tx, `refund:${row.id}`, order.currency, order.id, 'Confirmed customer refund', {
          'provider-collected': -row.amount_minor,
          'seller-gross': row.amount_minor - row.commission_minor,
          'platform-commission': row.commission_minor,
        });
        if (row.commission_minor > 0) await enqueue(tx, 'refund.fee', row.id, { refundId: row.id });
      }
      const totals = (
        await tx.query(
          "SELECT count(*)::int AS total,count(*) FILTER(WHERE status='refunded')::int AS refunded FROM tickets WHERE order_id=$1",
          [order.id],
        )
      ).rows[0]!;
      if (order.payment_role === 'group-contribution') {
        const sum = Number(
          (
            await tx.query(
              "SELECT coalesce(sum(amount_minor),0) AS amount FROM refunds WHERE order_id=$1 AND status='succeeded'",
              [order.id],
            )
          ).rows[0].amount,
        );
        const lost = Number(
          (
            await tx.query(
              "SELECT coalesce(sum(amount_minor),0) AS amount FROM provider_disputes WHERE order_id=$1 AND status='lost'",
              [order.id],
            )
          ).rows[0].amount,
        );
        totals.total = order.total_minor;
        totals.refunded = sum + lost;
      }
      if (status === 'succeeded' && totals.total === totals.refunded) {
        const table = (
          await tx.query('SELECT * FROM table_reservations WHERE order_id=$1 FOR UPDATE', [order.id])
        ).rows[0];
        if (table) {
          const collected = Number(
            (
              await tx.query(
                'SELECT coalesce(sum(amount_minor),0) AS total FROM door_collections WHERE reservation_id=$1',
                [table.id],
              )
            ).rows[0].total,
          );
          await tx.query('UPDATE table_reservations SET status=$1 WHERE id=$2', [
            collected > 0 ? 'refund-review' : 'cancelled',
            table.id,
          ]);
          await tx.query("UPDATE table_allocations SET status='released' WHERE reservation_id=$1", [
            table.id,
          ]);
          const due = table.full_price_minor - table.online_amount_minor;
          await journal(
            tx,
            `table-cancel:${table.id}`,
            order.currency,
            order.id,
            'Reverse contracted table balance; collected door money remains refundable',
            { 'seller-table-remaining': due, 'seller-receivable': -due },
          );
        }
      }
      const unallocated = (
        await tx.query(
          "SELECT provider_id FROM external_refunds WHERE order_id=$1 AND allocated_refund_id IS NULL AND status IN ('pending','succeeded') LIMIT 1",
          [order.id],
        )
      ).rowCount;
      await tx.query('UPDATE orders SET status=$1,updated_at=now() WHERE id=$2', [
        unallocated
          ? 'review'
          : totals.refunded === totals.total
            ? 'refunded'
            : totals.refunded > 0
              ? 'partially-refunded'
              : 'paid',
        order.id,
      ]);
      await groupMoneyChanged(tx, order.id, 'refund');
      await notifyBuyer(
        tx,
        this.db.config,
        order.user_id,
        decrypt(order.buyer_email_encrypted, this.db.config.encryptionKeys) as string,
        `refund-${status}`,
        status === 'succeeded' ? 'Your Clubby refund was processed' : 'Your Clubby refund needs attention',
        `Booking ${order.id}\nRefund ${row.id}\nStatus: ${status}. A successful refund may take time to appear at your bank.`,
        `refund-result:${row.id}`,
        { kind: 'booking', id: order.id },
      );
      await audit(tx, null, 'refund.result', 'refund', row.id, 'Authoritative provider refund state', {
        status,
      });
    });
  }
  async refundFee(id: string) {
    const row = (
      await this.db.query(
        'SELECT r.*,a.provider_id AS payment_id,o.account_id FROM refunds r JOIN orders o ON o.id=r.order_id JOIN payment_attempts a ON a.order_id=o.id WHERE r.id=$1',
        [id],
      )
    ).rows[0];
    if (!row || row.status !== 'succeeded' || row.commission_minor === 0 || row.fee_provider_id) return;
    await this.db.query('UPDATE refunds SET fee_started_at=coalesce(fee_started_at,now()) WHERE id=$1', [id]);
    const started = (await this.db.query('SELECT fee_started_at FROM refunds WHERE id=$1', [id])).rows[0]!
      .fee_started_at as Date;
    if (Date.now() - started.getTime() > 23 * 3600_000)
      throw new Error('Application fee refund requires reconciliation.');
    const payment = await this.provider.payment(row.account_id, row.payment_id);
    if (!payment.chargeId) throw new Error('Captured charge unavailable.');
    const charge = await this.provider.charge(row.account_id, payment.chargeId);
    const fee =
      typeof charge.application_fee === 'string' ? charge.application_fee : charge.application_fee?.id;
    if (!fee) throw new Error('Application fee has not settled yet.');
    const reference = await this.provider.refundFee(fee, row.commission_minor, `fee-refund-${id}`);
    await this.db.query('UPDATE refunds SET fee_provider_id=$1 WHERE id=$2', [reference, id]);
  }
}
