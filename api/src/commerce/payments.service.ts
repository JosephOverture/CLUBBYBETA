import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { z } from 'zod';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { hash, decrypt } from '../platform/crypto';
import { enqueue, type TransactionalHandler, type ExternalHandler } from '../platform/jobs';
import { OrdersService } from './orders.service';
import { RefundsService } from './refunds.service';
import { SellersService } from './sellers.service';
import type { PaymentProvider, Refund } from './provider';
import { journal, notifyBuyer } from './core';
import type { Principal } from '../identity/identity.service';
import { audit } from '../organizations/organizations.service';
import { groupMoneyChanged } from '../groups/group-events';

export class PaymentsService {
  private verifier = new Stripe('sk_test_signature_only', { apiVersion: '2026-08-26.dahlia' });
  constructor(
    readonly db: Database,
    readonly provider: PaymentProvider,
    readonly orders: OrdersService,
    readonly refunds: RefundsService,
    readonly sellers: SellersService,
  ) {}
  async webhook(raw: Buffer | undefined, signature: string | undefined) {
    if (
      !raw ||
      !signature ||
      this.db.config.STRIPE_MODE === 'disabled' ||
      !this.db.config.STRIPE_WEBHOOK_SECRETS
    )
      throw new ApiError('INVALID_WEBHOOK', 'Webhook verification failed.', 400);
    let event: unknown;
    for (const secret of this.db.config.STRIPE_WEBHOOK_SECRETS.split(',')) {
      try {
        event = this.verifier.webhooks.constructEvent(raw, signature, secret, 300);
        break;
      } catch {
        /* Try the rotation overlap key without logging secrets or payloads. */
      }
    }
    const parsed = z
      .object({
        id: z.string().max(150),
        type: z.string().max(200),
        livemode: z.boolean(),
        account: z.string().optional(),
        related_object: z.object({ id: z.string() }).optional(),
        data: z.object({ object: z.object({ id: z.string().optional() }).passthrough() }).optional(),
      })
      .safeParse(event);
    if (!parsed.success || parsed.data.livemode !== (this.db.config.STRIPE_MODE === 'live'))
      throw new ApiError('INVALID_WEBHOOK', 'Webhook verification failed.', 400);
    const value = parsed.data;
    const objectId = value.related_object?.id ?? value.data?.object.id;
    const account =
      value.type.startsWith('v2.core.account') || value.type === 'account.updated'
        ? objectId
        : (value.account ?? 'platform');
    await this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        'INSERT INTO provider_inbox(event_id,event_type,account_id,object_id,payload_hash,livemode) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING event_id',
        [value.id, value.type, account ?? null, objectId ?? null, hash(raw.toString('utf8')), value.livemode],
      );
      if (inserted.rowCount) await enqueue(tx, 'provider.event', value.id, { eventId: value.id });
    });
    return { received: true };
  }
  async event(id: string) {
    const row = (await this.db.query('SELECT * FROM provider_inbox WHERE event_id=$1', [id])).rows[0];
    if (!row || row.processed_at) return;
    const account = row.account_id as string | undefined;
    const objectId = row.object_id as string | undefined;
    // Unknown accounts cannot affect Clubby. A verified signature alone does not confer tenant access.
    const known =
      account === 'platform'
        ? 1
        : account
          ? (
              await this.db.query('SELECT organization_id FROM seller_accounts WHERE account_id=$1', [
                account,
              ])
            ).rowCount
          : 0;
    if (known && account && row.event_type === 'balance.available') await this.reconcile(account);
    if (known && objectId && account) {
      if (row.event_type.startsWith('payment_intent.'))
        await this.orders.applyPayment(account, await this.provider.payment(account, objectId));
      else if (row.event_type === 'account.updated' || row.event_type.startsWith('v2.core.account'))
        await this.sellers.sync(account);
      else if (row.event_type.startsWith('refund.'))
        await this.observedRefund(account, await this.provider.refund(account, objectId));
      else if (row.event_type === 'charge.refunded') {
        const charge = await this.provider.charge(account, objectId);
        const payment =
          typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
        if (payment)
          for (const refund of await this.provider.refunds(account, payment))
            await this.observedRefund(account, refund);
      } else if (row.event_type.startsWith('charge.dispute.')) await this.dispute(account, objectId);
      else if (row.event_type.startsWith('payout.')) await this.payout(account, objectId);
    }
    await this.db.query('UPDATE provider_inbox SET processed_at=now() WHERE event_id=$1', [id]);
  }
  async observedRefund(account: string, value: Refund) {
    const known = z.string().uuid().safeParse(value.refundId);
    if (
      known.success &&
      (await this.db.query('SELECT id FROM refunds WHERE id=$1', [value.refundId])).rowCount
    ) {
      await this.refunds.complete(account, value);
      return;
    }
    const attempt = (
      await this.db.query('SELECT order_id FROM payment_attempts WHERE account_id=$1 AND provider_id=$2', [
        account,
        value.paymentId,
      ])
    ).rows[0];
    if (!attempt) return;
    await this.db.transaction(async (tx) => {
      const order = await this.orders.lock(tx, attempt.order_id);
      const existing = (
        await tx.query('SELECT allocated_refund_id FROM external_refunds WHERE provider_id=$1', [value.id])
      ).rows[0];
      if (existing?.allocated_refund_id) return;
      await tx.query(
        'INSERT INTO external_refunds(provider_id,order_id,amount_minor,currency,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_id) DO UPDATE SET status=EXCLUDED.status',
        [value.id, order.id, value.amount, value.currency, value.status],
      );
      if (value.status === 'succeeded' || value.status === 'pending')
        await tx.query("UPDATE orders SET status='review' WHERE id=$1", [order.id]);
      await groupMoneyChanged(tx, order.id, 'external-refund');
    });
  }
  async recoverOrder(actor: Principal, id: string, raw: unknown) {
    const input = z
      .object({
        providerPaymentId: z.string().regex(/^pi_[A-Za-z0-9]+$/),
        reason: z.string().min(10).max(1000),
      })
      .strict()
      .parse(raw);
    const row = (
      await this.db.query(
        'SELECT o.organization_id,o.venue_id,o.account_id,a.id AS attempt_id FROM orders o JOIN payment_attempts a ON a.order_id=o.id WHERE o.id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'Payment attempt not found.', 404);
    await this.sellers.organizations.authorize(actor, row.organization_id, 'finance.read', row.venue_id);
    const value = await this.provider.payment(row.account_id, input.providerPaymentId);
    if (value.orderId !== id || value.attemptId !== row.attempt_id)
      throw new ApiError('PAYMENT_MISMATCH', 'Provider payment is not associated with this order.', 409);
    await this.orders.applyPayment(row.account_id, value);
    await this.db.transaction((tx) =>
      audit(tx, actor.userId, 'payment.reconcile', 'order', id, input.reason, {
        providerPaymentId: value.id,
      }),
    );
    return { data: { reconciled: true } };
  }
  async dispute(account: string, id: string) {
    const dispute = await this.provider.dispute(account, id);
    const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id;
    const charge = await this.provider.charge(account, chargeId);
    const paymentId =
      typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    const attempt = (
      await this.db.query('SELECT order_id FROM payment_attempts WHERE account_id=$1 AND provider_id=$2', [
        account,
        paymentId,
      ])
    ).rows[0];
    await this.db.transaction(async (tx) => {
      if (attempt) await this.orders.lock(tx, attempt.order_id);
      await tx.query(
        'INSERT INTO provider_disputes(account_id,provider_id,order_id,status,amount_minor,currency,evidence_due_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,provider_id) DO UPDATE SET status=EXCLUDED.status,evidence_due_at=EXCLUDED.evidence_due_at,updated_at=now()',
        [
          account,
          id,
          attempt?.order_id ?? null,
          dispute.status,
          dispute.amount,
          dispute.currency.toUpperCase(),
          dispute.evidence_details.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null,
        ],
      );
      if (attempt) {
        const blocked =
          ((
            await tx.query(
              "SELECT id FROM orders WHERE id=$1 AND EXISTS(SELECT 1 FROM provider_disputes d WHERE d.order_id=$1 AND d.status NOT IN ('won','warning_closed'))",
              [attempt.order_id],
            )
          ).rowCount ?? 0) > 0;
        await tx.query('UPDATE orders SET dispute_open=$1 WHERE id=$2', [blocked, attempt.order_id]);
        if (dispute.status === 'lost')
          await journal(
            tx,
            `dispute-loss:${id}`,
            dispute.currency.toUpperCase(),
            attempt.order_id,
            'Seller principal lost to a provider chargeback',
            { 'provider-collected': -dispute.amount, 'seller-dispute-loss': dispute.amount },
          );
        if (
          dispute.status === 'won' &&
          (await tx.query('SELECT id FROM ledger_journals WHERE reference=$1', [`dispute-loss:${id}`]))
            .rowCount
        )
          await journal(
            tx,
            `dispute-recovered:${id}`,
            dispute.currency.toUpperCase(),
            attempt.order_id,
            'Provider recovered a previously lost seller chargeback',
            { 'provider-collected': dispute.amount, 'seller-dispute-loss': -dispute.amount },
          );
        if (dispute.status === 'won')
          await tx.query(
            "UPDATE orders o SET status='partially-refunded' WHERE o.id=$1 AND o.payment_role='group-contribution' AND o.status='refunded' AND coalesce((SELECT sum(r.amount_minor) FROM refunds r WHERE r.order_id=o.id AND r.status='succeeded'),0)+coalesce((SELECT sum(d.amount_minor) FROM provider_disputes d WHERE d.order_id=o.id AND d.status='lost'),0)<o.total_minor",
            [attempt.order_id],
          );
        await groupMoneyChanged(tx, attempt.order_id, 'dispute');
      }
    });
  }
  async payout(account: string, id: string) {
    const value = await this.provider.payout(account, id);
    await this.db.query(
      'INSERT INTO provider_payouts(account_id,provider_id,status,amount_minor,currency,arrival_date,failure_code) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,provider_id) DO UPDATE SET status=EXCLUDED.status,failure_code=EXCLUDED.failure_code,updated_at=now()',
      [
        account,
        id,
        value.status,
        value.amount,
        value.currency.toUpperCase(),
        new Date(value.arrival_date * 1000),
        value.failure_code,
      ],
    );
  }
  async reconcile(account: string) {
    const runId = randomUUID();
    await this.db.query("INSERT INTO reconciliation_runs(id,account_id,status) VALUES($1,$2,'running')", [
      runId,
      account,
    ]);
    try {
      let after: string | undefined;
      let count = 0;
      do {
        const page = await this.provider.transactions(account, after);
        await this.db.transaction(async (tx) => {
          for (const value of page.data) {
            const inserted = await tx.query(
              'INSERT INTO provider_balance_transactions(account_id,provider_id,currency,amount_minor,fee_minor,net_minor,source_id,kind,created_at,available_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING provider_id',
              [
                account,
                value.id,
                value.currency.toUpperCase(),
                value.amount,
                value.fee,
                value.net,
                typeof value.source === 'string' ? value.source : (value.source?.id ?? null),
                value.type,
                new Date(value.created * 1000),
                new Date(value.available_on * 1000),
              ],
            );
            if (inserted.rowCount)
              await journal(
                tx,
                `provider:${account}:${value.id}`,
                value.currency.toUpperCase(),
                null,
                `Provider balance activity: ${value.type}`,
                {
                  [`provider-cash:${account}`]: value.net,
                  [`provider-fees:${account}`]: value.fee,
                  [`provider-activity:${account}`]: -value.amount,
                },
                'provider',
              );
            const source = typeof value.source === 'string' ? value.source : value.source?.id;
            if (source) {
              const topic = source.startsWith('dp_')
                ? 'provider.dispute'
                : source.startsWith('po_')
                  ? 'provider.payout'
                  : source.startsWith('re_')
                    ? 'provider.refund'
                    : null;
              if (topic)
                await enqueue(tx, topic, `${account}:${source}:${Math.floor(Date.now() / 3600_000)}`, {
                  accountId: account,
                  id: source,
                });
            }
            count++;
          }
        });
        after = page.hasMore ? page.data.at(-1)?.id : undefined;
        if (page.hasMore && !after) throw new Error('Invalid provider pagination.');
      } while (after);
      const balance = await this.provider.balance(account);
      const sums = (
        await this.db.query(
          'SELECT currency,sum(net_minor)::text AS amount FROM provider_balance_transactions WHERE account_id=$1 GROUP BY currency',
          [account],
        )
      ).rows;
      const expected = new Map<string, number>();
      for (const item of [...balance.available, ...balance.pending])
        expected.set(
          item.currency.toUpperCase(),
          (expected.get(item.currency.toUpperCase()) ?? 0) + item.amount,
        );
      const currencies = new Set([...expected.keys(), ...sums.map((s) => s.currency)]);
      const differences = [...currencies]
        .map((currency) => ({
          currency,
          recorded: Number(sums.find((s) => s.currency === currency)?.amount ?? 0),
          provider: expected.get(currency) ?? 0,
        }))
        .filter((s) => s.recorded !== s.provider);
      // Stripe balances can change during pagination; a mismatch is a review signal, never an invented balancing entry.
      await this.db.query(
        'UPDATE reconciliation_runs SET status=$1,details=$2,completed_at=now() WHERE id=$3',
        [
          differences.length ? 'review' : 'matched',
          JSON.stringify({ transactions: count, differences }),
          runId,
        ],
      );
    } catch {
      await this.db.query("UPDATE reconciliation_runs SET status='failed',completed_at=now() WHERE id=$1", [
        runId,
      ]);
      throw new Error('Provider reconciliation failed.');
    }
  }
  catalogueChanged: TransactionalHandler = async (tx, payload) => {
    const { changeId } = z.object({ changeId: z.string().uuid() }).parse(payload);
    const change = (await tx.query('SELECT * FROM catalogue_changes WHERE id=$1 FOR UPDATE', [changeId]))
      .rows[0];
    if (!change || change.processed_at) return;
    await tx.query('SELECT id FROM occurrences WHERE id=$1 FOR UPDATE', [change.aggregate_id]);
    const orders = (
      await tx.query(
        "SELECT * FROM orders WHERE occurrence_id=$1 AND status NOT IN ('cancelled','refunded') ORDER BY id FOR UPDATE",
        [change.aggregate_id],
      )
    ).rows;
    for (const order of orders) {
      const cancelBooking = change.kind === 'cancel' || Boolean(order.snapshot.table);
      if (cancelBooking) {
        await tx.query('UPDATE orders SET cancellation_requested=true WHERE id=$1', [order.id]);
        if (['held', 'payment-pending'].includes(order.status))
          await enqueue(tx, 'payment.expire', order.id, { orderId: order.id });
        else await enqueue(tx, 'payment.compensate', order.id, { orderId: order.id });
      }
      await notifyBuyer(
        tx,
        this.db.config,
        order.user_id,
        decrypt(order.buyer_email_encrypted, this.db.config.encryptionKeys) as string,
        'event-changed',
        'Your Clubby event has changed',
        `Booking ${order.id}\nEvent change: ${change.kind}\n${cancelBooking ? 'The cancellation and refund workflow has started. Table appointments are not automatically moved to another time. Any money collected at the door is refunded separately by the seller.' : 'Check the updated event schedule in Clubby. Contact booking support if you cannot attend.'}`,
        `event-change:${changeId}:${order.id}`,
        { kind: 'booking', id: order.id },
      );
      const holders = (
        await tx.query(
          `SELECT DISTINCT ON (t.owner_id) t.id,u.id AS user_id,u.email FROM tickets t JOIN users u ON u.id=t.owner_id WHERE t.order_id=$1 AND t.owner_id<>$2 AND u.status='active' AND u.email IS NOT NULL ORDER BY t.owner_id,t.id`,
          [order.id, order.user_id],
        )
      ).rows;
      for (const holder of holders)
        await notifyBuyer(
          tx,
          this.db.config,
          holder.user_id,
          holder.email,
          'event-changed',
          'Your Clubby event has changed',
          `Event change: ${change.kind}. Open your ticket to check the current schedule and admission status. Any refund goes to the original payer.`,
          `event-change-holder:${changeId}:${order.id}:${holder.user_id}`,
          { kind: 'ticket', id: holder.id },
        );
    }
    await tx.query('UPDATE catalogue_changes SET processed_at=now() WHERE id=$1', [changeId]);
  };
  externalHandlers(): Record<string, ExternalHandler> {
    return {
      'card.redisplay': (payload) =>
        this.orders.savedMethods.redisplay(
          z.object({ attemptId: z.string().uuid() }).parse(payload).attemptId,
        ),
      'card.remove': (payload) =>
        this.orders.savedMethods.processRemoval(
          z.object({ removalId: z.string().uuid() }).parse(payload).removalId,
        ),
      'payment.prepare': async (payload) =>
        this.orders.prepare(z.object({ attemptId: z.string().uuid() }).parse(payload).attemptId),
      'payment.expire': async (payload) =>
        this.orders.expire(z.object({ orderId: z.string().uuid() }).parse(payload).orderId),
      'payment.compensate': async (payload) =>
        this.refunds.compensate(z.object({ orderId: z.string().uuid() }).parse(payload).orderId),
      'refund.process': async (payload) =>
        this.refunds.process(z.object({ refundId: z.string().uuid() }).parse(payload).refundId),
      'refund.fee': async (payload) =>
        this.refunds.refundFee(z.object({ refundId: z.string().uuid() }).parse(payload).refundId),
      'provider.event': async (payload) =>
        this.event(z.object({ eventId: z.string() }).parse(payload).eventId),
      'seller.sync': async (payload) => {
        await this.sellers.sync(z.object({ accountId: z.string() }).parse(payload).accountId);
      },
      'provider.reconcile': async (payload) =>
        this.reconcile(z.object({ accountId: z.string() }).parse(payload).accountId),
      'provider.dispute': async (payload) => {
        const value = z.object({ accountId: z.string(), id: z.string() }).parse(payload);
        await this.dispute(value.accountId, value.id);
      },
      'provider.payout': async (payload) => {
        const value = z.object({ accountId: z.string(), id: z.string() }).parse(payload);
        await this.payout(value.accountId, value.id);
      },
      'provider.refund': async (payload) => {
        const value = z.object({ accountId: z.string(), id: z.string() }).parse(payload);
        await this.observedRefund(value.accountId, await this.provider.refund(value.accountId, value.id));
      },
      'payment.sync': async (payload) => {
        const { attemptId } = z.object({ attemptId: z.string().uuid() }).parse(payload);
        const row = (await this.db.query('SELECT * FROM payment_attempts WHERE id=$1', [attemptId])).rows[0];
        if (row?.provider_id)
          await this.orders.applyPayment(
            row.account_id,
            await this.provider.payment(row.account_id, row.provider_id),
          );
        else await this.orders.prepare(attemptId);
      },
    };
  }
  async maintenance() {
    if (this.db.config.STRIPE_MODE === 'disabled') return;
    const minute = Math.floor(Date.now() / 60_000),
      hour = Math.floor(Date.now() / 3600_000);
    await this.db.transaction(async (tx) => {
      await enqueue(tx, 'provider.reconcile', `platform:${hour}`, { accountId: 'platform' });
      const expiring = (
        await tx.query(
          "SELECT id FROM orders WHERE status IN ('held','payment-pending') AND (expires_at<=now() OR cancellation_requested) ORDER BY expires_at LIMIT 100",
        )
      ).rows;
      for (const order of expiring)
        await enqueue(tx, 'payment.expire', `${order.id}:${minute}`, { orderId: order.id });
      const pending = (
        await tx.query(
          "SELECT a.id FROM payment_attempts a JOIN orders o ON o.id=a.order_id WHERE o.status='payment-pending' AND (a.checked_at IS NULL OR a.checked_at<now()-interval '1 minute') ORDER BY a.created_at LIMIT 100",
        )
      ).rows;
      for (const row of pending)
        await enqueue(tx, 'payment.sync', `${row.id}:${minute}`, { attemptId: row.id });
      const refunds = (
        await tx.query(
          "SELECT id FROM refunds WHERE status IN ('queued','pending') ORDER BY created_at LIMIT 100",
        )
      ).rows;
      for (const row of refunds)
        await enqueue(tx, 'refund.process', `${row.id}:${minute}`, { refundId: row.id });
      const accounts = (
        await tx.query(
          "SELECT account_id FROM seller_accounts WHERE account_id IS NOT NULL AND (synced_at IS NULL OR synced_at<now()-interval '5 minutes') ORDER BY synced_at NULLS FIRST LIMIT 50",
        )
      ).rows;
      for (const row of accounts) {
        await enqueue(tx, 'seller.sync', `${row.account_id}:${minute}`, { accountId: row.account_id });
        await enqueue(tx, 'provider.reconcile', `${row.account_id}:${hour}`, { accountId: row.account_id });
      }
      const compensation = (
        await tx.query(
          "SELECT id FROM orders WHERE cancellation_requested AND status IN ('paid','partially-refunded') LIMIT 100",
        )
      ).rows;
      for (const row of compensation)
        await enqueue(tx, 'payment.compensate', `${row.id}:${minute}`, { orderId: row.id });
    });
  }
}
