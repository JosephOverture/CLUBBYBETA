import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { enqueue } from '../platform/jobs';
import { ApiError } from '../platform/http';

export async function groupEvent(
  tx: PoolClient,
  groupId: string,
  kind: string,
  payload: Record<string, unknown> = {},
) {
  await tx.query('INSERT INTO group_events(group_id,kind,payload) VALUES($1,$2,$3)', [
    groupId,
    kind,
    JSON.stringify(payload),
  ]);
}
export async function cancelGroup(
  tx: PoolClient,
  group: any,
  reason: string,
  kind: 'cancelled' | 'expired' = 'cancelled',
) {
  if (['cancelled', 'expired'].includes(group.state)) return;
  await tx.query(
    "UPDATE booking_groups SET state='cancelling',cancellation_reason=coalesce(cancellation_reason,$1),cancellation_kind=coalesce(cancellation_kind,$2),version=version+1 WHERE id=$3",
    [reason, kind, group.id],
  );
  await tx.query(
    "UPDATE orders SET cancellation_requested=true,status=CASE WHEN paid_at IS NULL THEN status ELSE 'refund-pending' END WHERE id=$1",
    [group.order_id],
  );
  await tx.query("UPDATE tickets SET status='refund-pending' WHERE order_id=$1 AND status='valid'", [
    group.order_id,
  ]);
  await enqueue(tx, 'group.reconcile', randomUUID(), { groupId: group.id });
  await groupEvent(tx, group.id, 'cancellation', { reason });
}
/** Recompute risk in the payment transaction, so a queue delay cannot leave group admission usable. */
export async function groupMoneyChanged(tx: PoolClient, orderId: string, kind: string) {
  const group = (
    await tx.query(
      'SELECT g.*,c.id AS contribution_id FROM booking_groups g JOIN group_contributions c ON c.group_id=g.id WHERE c.order_id=$1 FOR UPDATE OF g',
      [orderId],
    )
  ).rows[0];
  if (!group) return;
  const risk = (
    await tx.query(
      "SELECT bool_or(o.dispute_open OR o.status='review') AS blocked,coalesce(sum(CASE WHEN o.status IN ('paid','partially-refunded') AND NOT EXISTS(SELECT 1 FROM provider_disputes d WHERE d.order_id=o.id AND d.status='lost') THEN o.total_minor-coalesce((SELECT sum(r.amount_minor) FROM refunds r WHERE r.order_id=o.id AND r.status='succeeded'),0) ELSE 0 END),0)::int AS funded FROM group_contributions c JOIN orders o ON o.id=c.order_id WHERE c.group_id=$1",
      [group.id],
    )
  ).rows[0]!;
  await tx.query('UPDATE orders SET dispute_open=$1 WHERE id=$2', [Boolean(risk.blocked), group.order_id]);
  if (
    group.confirmed_at &&
    risk.funded < group.target_minor &&
    !['cancelling', 'cancelled', 'expired'].includes(group.state)
  ) {
    const consumed = (
      await tx.query(
        "SELECT id FROM tickets WHERE order_id=$1 AND (admitted_at IS NOT NULL OR drinks_used>0 OR EXISTS(SELECT 1 FROM table_reservations r WHERE r.order_id=$1 AND r.status='no-show')) LIMIT 1",
        [group.order_id],
      )
    ).rowCount;
    if (consumed) {
      await tx.query("UPDATE booking_groups SET state='review',version=version+1 WHERE id=$1", [group.id]);
      await tx.query('UPDATE orders SET dispute_open=true WHERE id=$1', [group.order_id]);
    } else await cancelGroup(tx, group, 'A contribution was refunded or lost to a chargeback.');
  }
  await groupEvent(tx, group.id, kind, { contributionId: group.contribution_id });
  if (['cancelled', 'expired'].includes(group.state)) {
    const contribution = (await tx.query('SELECT status,dispute_open FROM orders WHERE id=$1', [orderId]))
      .rows[0]!;
    if (!contribution.dispute_open && ['paid', 'partially-refunded'].includes(contribution.status))
      await enqueue(tx, 'payment.compensate', randomUUID(), { orderId });
  }
  await enqueue(tx, 'group.reconcile', randomUUID(), { groupId: group.id });
}
export async function assertContributionPayable(tx: PoolClient, order: any) {
  if (order.payment_role === 'group-reservation')
    throw new ApiError(
      'GROUP_FUNDING_REQUIRED',
      'Use the group contribution flow for this reservation.',
      409,
    );
  if (order.payment_role !== 'group-contribution') return;
  const group = (
    await tx.query(
      'SELECT g.*,m.status AS membership FROM group_contributions c JOIN booking_groups g ON g.id=c.group_id JOIN group_members m ON m.group_id=g.id AND m.user_id=c.user_id WHERE c.order_id=$1',
      [order.id],
    )
  ).rows[0];
  if (
    !group ||
    group.state !== 'funding' ||
    group.membership !== 'active' ||
    group.deadline.getTime() <= Date.now()
  )
    throw new ApiError('GROUP_CLOSED', 'The group no longer accepts this contribution.', 409);
}
