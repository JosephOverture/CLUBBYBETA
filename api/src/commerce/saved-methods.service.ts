import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { enqueue } from '../platform/jobs';
import type { Principal } from '../identity/identity.service';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import type { PaymentProvider } from './provider';
export class SavedMethodsService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
    readonly provider: PaymentProvider,
  ) {}
  async forOrder(actor: Principal, orderId: string) {
    this.organizations.verified(actor);
    const order = (
      await this.db.query(
        "SELECT account_id FROM orders WHERE id=$1 AND user_id=$2 AND status IN ('held','payment-pending') AND NOT cancellation_requested AND expires_at>now()",
        [orderId, actor.userId],
      )
    ).rows[0];
    if (!order) throw new ApiError('ORDER_NOT_PAYABLE', 'No payable booking found.', 409);
    return this.customer(actor, order.account_id);
  }
  async customer(actor: Principal, account: string) {
    this.organizations.verified(actor);
    const mapping = (
      await this.db.query(
        `INSERT INTO payment_customers(id,user_id,account_id) VALUES($1,$2,$3)
      ON CONFLICT(user_id,account_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING *`,
        [randomUUID(), actor.userId, account],
      )
    ).rows[0]!;
    if (mapping.status === 'ready') return mapping.provider_id as string;
    if (['deleting', 'deleted'].includes(mapping.status))
      throw new ApiError(
        'SAVED_METHODS_UNAVAILABLE',
        'Saved payment methods are being removed for this account.',
        409,
      );
    let id: string | null;
    if (Date.now() - mapping.created_at.getTime() > 23 * 3600_000) {
      id = await this.provider.findCustomer(account, mapping.id);
      if (!id) {
        await this.db.query(
          "UPDATE payment_customers SET status='review' WHERE id=$1 AND status='creating'",
          [mapping.id],
        );
        throw new ApiError(
          'SAVED_METHODS_REVIEW',
          'Saved methods need provider reconciliation. You can pay without saved methods.',
          409,
        );
      }
    } else
      id = await this.provider.createCustomer(account, mapping.id, actor.userId, `customer-${mapping.id}`);
    const changed = await this.db.query(
      "UPDATE payment_customers SET provider_id=$1,status='ready' WHERE id=$2 AND status IN ('creating','review','ready') AND (provider_id IS NULL OR provider_id=$1) RETURNING id",
      [id, mapping.id],
    );
    if (!changed.rowCount) {
      // Deletion may have won while provider creation was in flight. Its idempotency
      // key is shared with erasure, so both paths clean up the same customer.
      const current = (await this.db.query('SELECT status FROM payment_customers WHERE id=$1', [mapping.id]))
        .rows[0];
      if (current && ['deleting', 'deleted'].includes(current.status))
        await this.provider.deleteCustomer(account, id);
      throw new Error('Customer mapping changed during provider creation.');
    }
    return id;
  }
  async sellers(actor: Principal) {
    this.organizations.verified(actor);
    return {
      data: (
        await this.db.query(
          `SELECT c.id,o.name AS "sellerName",c.status FROM payment_customers c JOIN seller_accounts s ON s.account_id=c.account_id JOIN organizations o ON o.id=s.organization_id WHERE c.user_id=$1 AND c.status<>'deleted' ORDER BY o.name,c.id`,
          [actor.userId],
        )
      ).rows,
    };
  }
  async scoped(actor: Principal, id: string) {
    this.organizations.verified(actor);
    const c = (
      await this.db.query("SELECT * FROM payment_customers WHERE id=$1 AND user_id=$2 AND status='ready'", [
        z.string().uuid().parse(id),
        actor.userId,
      ])
    ).rows[0];
    if (!c) throw new ApiError('NOT_FOUND', 'Saved payment account not found.', 404);
    return c;
  }
  async list(actor: Principal, id: string, after?: string) {
    const c = await this.scoped(actor, id);
    if (after)
      z.string()
        .regex(/^pm_[A-Za-z0-9]+$/)
        .parse(after);
    const result = await this.provider.cards(c.account_id, c.provider_id, after);
    const removed = (
      await this.db.query('SELECT method_id FROM saved_method_removals WHERE customer_id=$1', [c.id])
    ).rows.map((r) => r.method_id);
    return {
      data: result.data.filter((m) => !removed.includes(m.id)),
      meta: { nextCursor: result.hasMore ? (result.data.at(-1)?.id ?? null) : null },
    };
  }
  async remove(actor: Principal, id: string, raw: unknown) {
    const input = z
        .object({ methodId: z.string().regex(/^pm_[A-Za-z0-9]+$/) })
        .strict()
        .parse(raw),
      c = await this.scoped(actor, id);
    const previous = (
      await this.db.query('SELECT id FROM saved_method_removals WHERE customer_id=$1 AND method_id=$2', [
        c.id,
        input.methodId,
      ])
    ).rows[0];
    if (!previous && !(await this.provider.ownsCard(c.account_id, c.provider_id, input.methodId)))
      throw new ApiError('NOT_FOUND', 'Saved method not found.', 404);
    // Only the provider can decide whether a method belongs to this connected-account customer.
    const removal = await this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          `INSERT INTO saved_method_removals(id,user_id,customer_id,method_id) VALUES($1,$2,$3,$4) ON CONFLICT(customer_id,method_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING id,status`,
          [randomUUID(), actor.userId, c.id, input.methodId],
        )
      ).rows[0];
      await enqueue(tx, 'card.remove', row.id, { removalId: row.id });
      await audit(
        tx,
        actor.userId,
        'payment-method.remove',
        'payment-customer',
        c.id,
        'Customer requested removal of saved card',
        { removalId: row.id },
      );
      return row;
    });
    await this.processRemoval(removal.id);
    return { data: { id: removal.id, status: 'completed' } };
  }
  async processRemoval(id: string) {
    const row = (
      await this.db.query(
        'SELECT r.*,c.account_id,c.provider_id FROM saved_method_removals r JOIN payment_customers c ON c.id=r.customer_id WHERE r.id=$1',
        [id],
      )
    ).rows[0];
    if (!row || row.status === 'completed') return;
    await this.provider.removeCard(row.account_id, row.provider_id, row.method_id, `card-remove-${id}`);
    await this.db.query(
      "UPDATE saved_method_removals SET status='completed',completed_at=now() WHERE id=$1",
      [id],
    );
  }
  async redisplay(attemptId: string) {
    const attempt = (
      await this.db.query(
        `SELECT a.*,u.status AS user_status,c.status AS customer_status FROM payment_attempts a JOIN orders o ON o.id=a.order_id JOIN users u ON u.id=o.user_id
      JOIN payment_customers c ON c.account_id=a.account_id AND c.provider_id=a.customer_id WHERE a.id=$1`,
        [attemptId],
      )
    ).rows[0];
    if (
      !attempt ||
      !attempt.save_card ||
      attempt.card_save_status !== 'pending' ||
      attempt.status !== 'succeeded' ||
      attempt.user_status !== 'active' ||
      attempt.customer_status !== 'ready'
    )
      return;
    const status = await this.provider.allowCardRedisplay(
      attempt.account_id,
      attempt.customer_id,
      attempt.provider_id,
      `card-consent-${attempt.id}`,
    );
    await this.db.query(
      "UPDATE payment_attempts SET card_save_status=$1 WHERE id=$2 AND card_save_status='pending'",
      [status, attemptId],
    );
  }
  async eraseUser(userId: string) {
    const rows = (
      await this.db.query(
        "UPDATE payment_customers SET status='deleting' WHERE user_id=$1 AND status<>'deleted' RETURNING *",
        [userId],
      )
    ).rows;
    for (const row of rows) {
      let id = row.provider_id ?? (await this.provider.findCustomer(row.account_id, row.id));
      if (!id && Date.now() - row.created_at.getTime() < 23 * 3600_000)
        id = await this.provider.createCustomer(row.account_id, row.id, row.user_id, `customer-${row.id}`);
      if (id) await this.provider.deleteCustomer(row.account_id, id);
      await this.db.query("UPDATE payment_customers SET status='deleted',provider_id=NULL WHERE id=$1", [
        row.id,
      ]);
    }
  }
}
