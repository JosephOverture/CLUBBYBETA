import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import type { Principal } from '../identity/identity.service';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import { OrdersService } from './orders.service';
import { RefundsService } from './refunds.service';
import { idempotent, notifyBuyer } from './core';
import { decrypt } from '../platform/crypto';

export class BookingSupportService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
    readonly orders: OrdersService,
    readonly refunds: RefundsService,
  ) {}
  private async notify(tx: PoolClient, row: any, actorId: string, version: number) {
    const recipients =
      actorId !== row.user_id
        ? (
            await tx.query(
              "SELECT u.id,coalesce(u.email,CASE WHEN o.user_id=u.id THEN o.buyer_email_encrypted END) AS email_value,(u.email IS NULL) AS encrypted FROM users u JOIN orders o ON o.id=$2 WHERE u.id=$1 AND u.status='active'",
              [row.user_id, row.order_id],
            )
          ).rows
        : (
            await tx.query(
              `SELECT u.id,u.email AS email_value,false AS encrypted FROM users u WHERE u.status='active' AND u.email IS NOT NULL AND (u.id=$1 OR EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.organization_id=$2 AND m.status='active' AND m.role IN ('owner','manager') AND (m.venue_ids IS NULL OR $3=ANY(m.venue_ids)))) ORDER BY u.id`,
              [row.assigned_to, row.organization_id, row.venue_id],
            )
          ).rows;
    for (const recipient of recipients) {
      if (!recipient.email_value || recipient.id === actorId) continue;
      const email = recipient.encrypted
        ? (decrypt(recipient.email_value, this.db.config.encryptionKeys) as string)
        : recipient.email_value;
      await notifyBuyer(
        tx,
        this.db.config,
        recipient.id,
        email,
        'support-update',
        'Your Clubby support case has an update',
        'Open the support conversation in Clubby to read the latest reply and status.',
        `support:${row.id}:${version}:${recipient.id}`,
        { kind: 'support', id: row.id },
      );
    }
  }
  async createForTicket(actor: Principal, ticketId: string, raw: unknown, key: unknown) {
    const row = (
      await this.db.query('SELECT order_id FROM tickets WHERE id=$1 AND owner_id=$2', [
        ticketId,
        actor.userId,
      ])
    ).rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'Ticket not found.', 404);
    return this.create(actor, row.order_id, raw, key, ticketId);
  }
  async create(actor: Principal, orderId: string, raw: unknown, key: unknown, ticketId?: string) {
    const input = z
      .object({ subject: z.string().trim().min(5).max(150), message: z.string().trim().min(10).max(5000) })
      .strict()
      .parse(raw);
    return this.db.transaction((tx) =>
      idempotent(
        tx,
        actor.userId,
        `support:${orderId}`,
        key,
        { ...input, ticketId: ticketId ?? null },
        async () => {
          const order = await this.orders.lock(tx, orderId);
          if (ticketId) {
            if (
              !(
                await tx.query(
                  'SELECT id FROM tickets WHERE id=$1 AND order_id=$2 AND owner_id=$3 FOR SHARE',
                  [ticketId, orderId, actor.userId],
                )
              ).rowCount
            )
              throw new ApiError('NOT_FOUND', 'Ticket not found.', 404);
          } else this.orders.owner(actor, order);
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,81))', [actor.userId]);
          if (
            (
              await tx.query(
                "SELECT id FROM support_cases WHERE order_id=$1 AND user_id=$2 AND status<>'resolved'",
                [orderId, actor.userId],
              )
            ).rowCount
          )
            throw new ApiError(
              'CASE_EXISTS',
              'Use your existing open support conversation for this booking.',
              409,
            );
          if (
            (
              await tx.query(
                "SELECT count(*)::int AS n FROM support_cases WHERE user_id=$1 AND created_at>now()-interval '1 day'",
                [actor.userId],
              )
            ).rows[0]!.n >= 10
          )
            throw new ApiError(
              'SUPPORT_LIMIT',
              'Please wait before opening another support conversation.',
              429,
            );
          const id = randomUUID();
          await tx.query(
            'INSERT INTO support_cases(id,order_id,user_id,subject,ticket_id) VALUES($1,$2,$3,$4,$5)',
            [id, orderId, actor.userId, input.subject, ticketId ?? null],
          );
          await this.notify(
            tx,
            {
              id,
              order_id: orderId,
              user_id: actor.userId,
              organization_id: order.organization_id,
              venue_id: order.venue_id,
            },
            actor.userId,
            1,
          );
          await audit(
            tx,
            actor.userId,
            'support.create',
            'support-case',
            id,
            'Account holder opened a support conversation',
          );
          await tx.query('INSERT INTO support_messages(id,case_id,actor_id,body) VALUES($1,$2,$3,$4)', [
            randomUUID(),
            id,
            actor.userId,
            input.message,
          ]);
          return { data: { id, status: 'open' } };
        },
      ),
    );
  }
  async authorize(actor: Principal, id: string, tx?: PoolClient) {
    const query = (sql: string, values: unknown[]) =>
      tx ? tx.query(sql, values) : this.db.query(sql, values);
    const row = (
      await query(
        `SELECT c.*,o.organization_id,o.venue_id FROM support_cases c JOIN orders o ON o.id=c.order_id WHERE c.id=$1 ${tx ? 'FOR UPDATE OF c' : ''}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'Support case not found.', 404);
    if (row.user_id !== actor.userId) {
      try {
        await this.organizations.authorize(
          actor,
          row.organization_id,
          'support.manage',
          row.venue_id,
          false,
          tx,
        );
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'FORBIDDEN') throw error;
        await this.organizations.platformAny(actor, ['admin', 'support'], tx ?? this.db);
      }
    }
    return row;
  }
  async view(actor: Principal, id: string, after = '0') {
    z.string()
      .regex(/^[0-9]{1,18}$/)
      .parse(after);
    const row = await this.authorize(actor, id);
    const messages = (
      await this.db.query(
        'SELECT id,sequence::text,actor_id,body,created_at FROM support_messages WHERE case_id=$1 AND support_messages.sequence>$2 ORDER BY support_messages.sequence LIMIT 100',
        [id, after],
      )
    ).rows;
    return {
      data: {
        ...row,
        messages,
      },
      meta: { nextCursor: messages.at(-1)?.sequence ?? after, hasMore: messages.length === 100 },
    };
  }
  async reply(actor: Principal, id: string, raw: unknown, key: unknown) {
    const input = z
      .object({
        message: z.string().trim().min(1).max(5000),
        status: z.enum(['open', 'waiting', 'resolved']),
        expectedVersion: z.number().int().positive(),
      })
      .strict()
      .parse(raw);
    return this.db.transaction((tx) =>
      idempotent(tx, actor.userId, `support.reply:${id}`, key, input, async () => {
        const row = await this.authorize(actor, id, tx);
        if (row.user_id === actor.userId && input.status === 'waiting')
          throw new ApiError(
            'INVALID_STATUS',
            'Only support staff can mark a case as waiting for the customer.',
            400,
          );
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,82))', [actor.userId]);
        if (
          (
            await tx.query(
              "SELECT count(*)::int n FROM support_messages WHERE actor_id=$1 AND created_at>now()-interval '1 minute'",
              [actor.userId],
            )
          ).rows[0]!.n >= 20
        )
          throw new ApiError('SUPPORT_LIMIT', 'Wait before sending another support message.', 429);
        const result = await tx.query(
          "UPDATE support_cases SET status=$1,version=version+1,updated_at=now(),resolved_at=CASE WHEN $1='resolved' THEN now() END WHERE id=$2 AND version=$3 RETURNING version",
          [input.status, id, input.expectedVersion],
        );
        if (!result.rowCount) throw new ApiError('VERSION_CONFLICT', 'Support case changed.', 409);
        await tx.query('INSERT INTO support_messages(id,case_id,actor_id,body) VALUES($1,$2,$3,$4)', [
          randomUUID(),
          id,
          actor.userId,
          input.message,
        ]);
        await audit(tx, actor.userId, 'support.reply', 'support-case', id, 'Booking support response', {
          status: input.status,
        });
        await this.notify(tx, row, actor.userId, result.rows[0]!.version);
        return { data: { id, version: result.rows[0]!.version, status: input.status } };
      }),
    );
  }
  async list(
    actor: Principal,
    organizationId?: string,
    options: { platform?: boolean; before?: string; status?: string } = {},
  ) {
    const before = options.before ? z.string().uuid().parse(options.before) : null;
    const status = options.status ? z.enum(['open', 'waiting', 'resolved']).parse(options.status) : null;
    if (options.platform) await this.organizations.platformAny(actor, ['admin', 'support']);
    const scope =
      organizationId && !options.platform
        ? await this.organizations.scope(actor, organizationId, 'support.manage')
        : null;
    const rows = (
      await this.db.query(
        `SELECT c.*,o.venue_id FROM support_cases c JOIN orders o ON o.id=c.order_id WHERE ($1::boolean OR ($2::uuid IS NOT NULL AND o.organization_id=$2 AND ($3::text[] IS NULL OR o.venue_id=ANY($3))) OR ($2::uuid IS NULL AND c.user_id=$4)) AND ($5::uuid IS NULL OR c.id<$5) AND ($6::text IS NULL OR c.status=$6) ORDER BY c.id DESC LIMIT 100`,
        [Boolean(options.platform), organizationId ?? null, scope, actor.userId, before, status],
      )
    ).rows;
    return { data: rows, meta: { nextCursor: rows.length === 100 ? rows.at(-1)!.id : null } };
  }
  async assign(actor: Principal, id: string, raw: unknown) {
    const input = z
      .object({
        userId: z.string().uuid().nullable(),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(10).max(1000),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const row = await this.authorize(actor, id, tx);
      await this.organizations.platformAny(actor, ['admin', 'support'], tx);
      if (
        input.userId &&
        !(
          await tx.query(
            "SELECT 1 FROM platform_grants g JOIN users u ON u.id=g.user_id WHERE g.user_id=$1 AND g.role IN ('admin','support') AND g.revoked_at IS NULL AND u.status='active'",
            [input.userId],
          )
        ).rowCount
      )
        throw new ApiError('INVALID_ASSIGNEE', 'Assign an active platform support agent.', 400);
      const updated = await tx.query(
        'UPDATE support_cases SET assigned_to=$1,version=version+1,updated_at=now() WHERE id=$2 AND version=$3 RETURNING id,version,assigned_to',
        [input.userId, id, input.expectedVersion],
      );
      if (!updated.rowCount) throw new ApiError('VERSION_CONFLICT', 'Support case changed.', 409);
      await audit(tx, actor.userId, 'support.assign', 'support-case', id, input.reason, {
        assignedTo: input.userId,
      });
      if (input.userId)
        await this.notify(tx, { ...row, assigned_to: input.userId }, row.user_id, updated.rows[0]!.version);
      return { data: updated.rows[0] };
    });
  }
  async finance(actor: Principal, organizationId: string) {
    await this.organizations.authorize(actor, organizationId, 'finance.read');
    const totals = (
      await this.db.query(
        `SELECT o.currency,count(*) FILTER(WHERE o.paid_at IS NOT NULL)::int AS paid_orders,
    coalesce(sum(o.total_minor) FILTER(WHERE o.paid_at IS NOT NULL),0)::text AS gross_minor,
    coalesce(sum(o.commission_minor) FILTER(WHERE o.paid_at IS NOT NULL),0)::text AS commission_minor,
    coalesce((SELECT sum(r.amount_minor) FROM refunds r JOIN orders ro ON ro.id=r.order_id WHERE ro.organization_id=$1 AND ro.currency=o.currency AND r.status='succeeded'),0)::text AS refunded_minor
    FROM orders o WHERE o.organization_id=$1 AND o.payment_role<>'group-reservation' GROUP BY o.currency`,
        [organizationId],
      )
    ).rows;
    return {
      data: {
        totals,
        disputes: (
          await this.db.query(
            'SELECT d.* FROM provider_disputes d JOIN seller_accounts a ON a.account_id=d.account_id WHERE a.organization_id=$1 ORDER BY d.updated_at DESC LIMIT 100',
            [organizationId],
          )
        ).rows,
        payouts: (
          await this.db.query(
            'SELECT p.* FROM provider_payouts p JOIN seller_accounts a ON a.account_id=p.account_id WHERE a.organization_id=$1 ORDER BY p.updated_at DESC LIMIT 100',
            [organizationId],
          )
        ).rows,
        reconciliation: (
          await this.db.query(
            'SELECT r.* FROM reconciliation_runs r JOIN seller_accounts a ON a.account_id=r.account_id WHERE a.organization_id=$1 ORDER BY r.created_at DESC LIMIT 10',
            [organizationId],
          )
        ).rows,
        externalRefunds: (
          await this.db.query(
            'SELECT r.* FROM external_refunds r JOIN orders o ON o.id=r.order_id WHERE o.organization_id=$1 AND r.allocated_refund_id IS NULL',
            [organizationId],
          )
        ).rows,
      },
    };
  }
  async allocateExternalRefund(actor: Principal, providerId: string, raw: unknown) {
    const input = z
      .object({ ticketIds: z.array(z.string().uuid()).max(50), reason: z.string().min(10).max(1000) })
      .strict()
      .parse(raw);
    const id = await this.db.transaction(async (tx) => {
      const reference = (await tx.query('SELECT * FROM external_refunds WHERE provider_id=$1', [providerId]))
        .rows[0];
      if (!reference) throw new ApiError('NOT_FOUND', 'External refund not found.', 404);
      const order = await this.orders.lock(tx, reference.order_id);
      await this.organizations.authorize(
        actor,
        order.organization_id,
        'booking.refund',
        order.venue_id,
        false,
        tx,
      );
      const current = (
        await tx.query('SELECT * FROM external_refunds WHERE provider_id=$1 FOR UPDATE', [providerId])
      ).rows[0]!;
      if (current.allocated_refund_id) return current.allocated_refund_id as string;
      if (current.status !== 'succeeded' || order.dispute_open)
        throw new ApiError(
          'REFUND_UNAVAILABLE',
          'Wait for the provider refund to succeed and resolve any dispute.',
          409,
        );
      if (order.payment_role === 'group-contribution' && input.ticketIds.length)
        throw new ApiError('INVALID_TICKETS', 'Contributions have no independent tickets.', 400);
      const amount =
        order.payment_role === 'group-contribution'
          ? current.amount_minor
          : Number(
              (
                await tx.query(
                  "SELECT coalesce(sum(amount_minor),0) AS total FROM tickets WHERE order_id=$1 AND id=ANY($2::uuid[]) AND status='valid'",
                  [order.id, input.ticketIds],
                )
              ).rows[0].total,
            );
      if (amount !== current.amount_minor || current.currency !== order.currency)
        throw new ApiError(
          'ALLOCATION_MISMATCH',
          'Choose the exact admissions covered by the provider refund.',
          409,
        );
      // Queue the established refund as a retrieval, never submit a second refund to Stripe.
      const restored = { ...order, status: 'paid' };
      const result = await this.refunds.queue(
        tx,
        restored,
        input.ticketIds,
        input.reason,
        actor.userId,
        true,
        order.payment_role === 'group-contribution' ? current.amount_minor : undefined,
      );
      await tx.query("UPDATE refunds SET provider_id=$1,status='pending',commission_minor=0 WHERE id=$2", [
        providerId,
        result.id,
      ]);
      await tx.query('UPDATE external_refunds SET allocated_refund_id=$1 WHERE provider_id=$2', [
        result.id,
        providerId,
      ]);
      return result.id;
    });
    return { data: { refundId: id } };
  }
}
