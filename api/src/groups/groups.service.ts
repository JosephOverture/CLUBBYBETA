import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { encrypt, decrypt, hash, secret } from '../platform/crypto';
import { enqueue } from '../platform/jobs';
import type { Principal } from '../identity/identity.service';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import { OrdersService } from '../commerce/orders.service';
import { RefundsService } from '../commerce/refunds.service';
import { TablesService } from '../tables/tables.service';
import { idempotent, journal, notifyBuyer } from '../commerce/core';
import { cancelGroup, groupEvent } from './group-events';
import { requireFeature } from '../administration/features';

const groupTerms =
  'Only confirmed contributions count. Funding must complete by the deadline or every captured contribution is refunded to its payer. The group owner is responsible for the remaining table balance before entry. Once confirmed, cancellation applies to the whole unused table under its booking terms. Leaving the conversation does not cancel a payment. Group members can see contribution amounts and display names.';
export class GroupsService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
    readonly orders: OrdersService,
    readonly refunds: RefundsService,
    readonly tables: TablesService,
  ) {}
  async lock(tx: PoolClient, id: string, actor?: Principal, owner = false) {
    const located = (await tx.query('SELECT order_id FROM booking_groups WHERE id=$1', [id])).rows[0];
    if (!located) throw new ApiError('NOT_FOUND', 'Group not found.', 404);
    const order = await this.orders.lock(tx, located.order_id);
    const group = (await tx.query('SELECT * FROM booking_groups WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
    if (actor) {
      await this.member(tx, id, actor);
      if (owner && group.owner_id !== actor.userId)
        throw new ApiError(
          'GROUP_OWNER_REQUIRED',
          'The responsible group owner must perform this action.',
          403,
        );
    }
    return { group, order };
  }
  async member(tx: Pick<PoolClient, 'query'>, id: string, actor: Principal) {
    this.organizations.verified(actor);
    if (
      !(
        await tx.query(
          "SELECT user_id FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='active'",
          [id, actor.userId],
        )
      ).rowCount
    )
      throw new ApiError('NOT_FOUND', 'Active group membership not found.', 404);
  }
  async create(actor: Principal, raw: unknown, key: unknown) {
    this.organizations.verified(actor);
    const input = z
      .object({
        name: z.string().trim().min(2).max(100),
        offerId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
        guests: z.number().int().min(2).max(50),
        paymentMode: z.enum(['full', 'deposit']),
        deadline: z.iso.datetime({ offset: true }),
        acceptTerms: z.literal(true),
        acceptBalanceResponsibility: z.literal(true),
      })
      .strict()
      .parse(raw);
    return this.db.transaction((tx) =>
      idempotent(tx, actor.userId, 'group.create', key, input, async () => {
        await requireFeature(tx, 'groupCreation');
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,42))', [actor.userId]);
        if (
          (
            await tx.query(
              "SELECT id FROM booking_groups WHERE owner_id=$1 AND state IN ('funding','review','cancelling') LIMIT 1",
              [actor.userId],
            )
          ).rowCount
        )
          throw new ApiError('GROUP_HOLD_LIMIT', 'Finish or cancel your current funding group first.', 429);
        const deadline = new Date(input.deadline);
        if (deadline.getTime() < Date.now() + 60_000 || deadline.getTime() > Date.now() + 3600_000)
          throw new ApiError(
            'INVALID_DEADLINE',
            'Choose a funding deadline one to sixty minutes from now.',
            400,
          );
        const reservation = await this.tables.hold(
          actor,
          {
            offerId: input.offerId,
            expectedVersion: input.expectedVersion,
            guests: input.guests,
            paymentMode: input.paymentMode,
            email: actor.email,
          },
          hash(`group-table:${String(key)}`),
          tx,
        );
        if (reservation.data.order.totalMinor < 50)
          throw new ApiError(
            'GROUP_TARGET_TOO_SMALL',
            'The group target must be at least 50 minor units.',
            409,
          );
        if (deadline.getTime() > Date.parse(reservation.data.order.snapshot.table!.slotStartsAt as string))
          throw new ApiError('INVALID_DEADLINE', 'Funding must finish before the table slot starts.', 400);
        const id = randomUUID();
        await tx.query(
          "UPDATE orders SET payment_role='group-reservation',expires_at=$1,buyer_accepted_at=now() WHERE id=$2",
          [deadline, reservation.data.order.id],
        );
        await tx.query(
          'INSERT INTO booking_groups(id,order_id,reservation_id,owner_id,name,deadline,target_minor,guests,currency,terms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            id,
            reservation.data.order.id,
            reservation.data.reservationId,
            actor.userId,
            input.name,
            deadline,
            reservation.data.order.totalMinor,
            input.guests,
            reservation.data.order.currency,
            groupTerms,
          ],
        );
        await tx.query('INSERT INTO group_members(group_id,user_id) VALUES($1,$2)', [id, actor.userId]);
        await groupEvent(tx, id, 'created');
        await audit(
          tx,
          actor.userId,
          'group.create',
          'group',
          id,
          'Accepted group terms and remaining balance responsibility',
          { reservationId: reservation.data.reservationId, deadline: deadline.toISOString() },
        );
        return {
          data: {
            id,
            orderId: reservation.data.order.id,
            reservationId: reservation.data.reservationId,
            deadline: deadline.toISOString(),
            targetMinor: reservation.data.order.totalMinor,
            terms: groupTerms,
          },
        };
      }),
    );
  }
  async list(actor: Principal) {
    return {
      data: (
        await this.db.query(
          'SELECT g.id,g.name,g.state,g.currency,g.target_minor AS "targetMinor",g.deadline FROM booking_groups g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=$1 AND m.status=\'active\' ORDER BY g.created_at DESC LIMIT 100',
          [actor.userId],
        )
      ).rows,
    };
  }
  async view(actor: Principal, id: string) {
    return this.db.transaction(async (tx) => {
      await this.member(tx, id, actor);
      const group = (
        await tx.query(
          'SELECT g.*,o.snapshot,o.dispute_open FROM booking_groups g JOIN orders o ON o.id=g.order_id WHERE g.id=$1',
          [id],
        )
      ).rows[0]!;
      const contributions = (
        await tx.query(
          'SELECT c.id,c.user_id AS "userId",CASE WHEN c.user_id=$2 THEN c.order_id ELSE NULL END AS "orderId",u.display_name AS "displayName",o.total_minor AS "amountMinor",o.status,o.dispute_open AS "disputeOpen",coalesce((SELECT sum(r.amount_minor) FROM refunds r WHERE r.order_id=o.id AND r.status=\'succeeded\'),0)::int AS "refundedMinor" FROM group_contributions c JOIN orders o ON o.id=c.order_id JOIN users u ON u.id=c.user_id WHERE c.group_id=$1 ORDER BY c.created_at,c.id',
          [id, actor.userId],
        )
      ).rows;
      const paid = contributions
        .filter((c) => ['paid', 'partially-refunded'].includes(c.status) && !c.disputeOpen)
        .reduce((sum, c) => sum + c.amountMinor - c.refundedMinor, 0);
      const reserved = contributions
        .filter((c) => !['cancelled', 'refunded'].includes(c.status))
        .reduce((sum, c) => sum + c.amountMinor, 0);
      const table = (
        await tx.query(
          'SELECT r.status,coalesce((SELECT sum(amount_minor) FROM door_collections WHERE reservation_id=r.id),0)::int AS collected FROM table_reservations r WHERE r.id=$1',
          [group.reservation_id],
        )
      ).rows[0]!;
      return {
        data: {
          id: group.id,
          name: group.name,
          state: group.state,
          ownerId: group.owner_id,
          ownerUnavailable: Boolean(
            (
              await tx.query("SELECT 1 FROM users WHERE id=$1 AND status IN ('deletion-pending','deleted')", [
                group.owner_id,
              ])
            ).rowCount,
          ),
          orderId: group.owner_id === actor.userId ? group.order_id : null,
          reservationId: group.reservation_id,
          targetMinor: group.target_minor,
          paidMinor: paid,
          reservedMinor: reserved,
          remainingMinor: Math.max(0, group.target_minor - reserved),
          currency: group.currency,
          deadline: group.deadline,
          terms: group.terms,
          version: group.version,
          snapshot: group.snapshot,
          disputeOpen: group.dispute_open,
          balanceDueMinor: ['held', 'confirmed'].includes(table.status)
            ? group.snapshot.table.fullPriceMinor - group.target_minor - table.collected
            : 0,
          contributions,
          members: (
            await tx.query(
              'SELECT m.user_id AS id,u.display_name AS "displayName",m.status FROM group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1 ORDER BY m.joined_at,m.user_id',
              [id],
            )
          ).rows,
          tickets: (
            await tx.query('SELECT id,status FROM tickets WHERE order_id=$1 AND owner_id=$2 ORDER BY id', [
              group.order_id,
              actor.userId,
            ])
          ).rows,
          ownershipOffers: (
            await tx.query(
              'SELECT id,from_user_id AS "fromUserId",to_user_id AS "toUserId",expires_at AS "expiresAt" FROM group_owner_transfers WHERE group_id=$1 AND status=\'pending\' AND expires_at>now()',
              [id],
            )
          ).rows,
        },
      };
    });
  }
  async invite(actor: Principal, id: string, raw: unknown) {
    const input = z
      .object({
        email: z
          .string()
          .email()
          .max(254)
          .transform((v) => v.toLowerCase()),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const { group } = await this.lock(tx, id, actor, true);
      if (group.state !== 'funding' || group.deadline.getTime() <= Date.now())
        throw new ApiError('GROUP_CLOSED', 'Invitations close when funding ends.', 409);
      if (
        (
          await tx.query(
            'SELECT 1 FROM user_blocks b JOIN users u ON u.id=b.user_id WHERE u.email=$1 AND b.blocked_user_id=$2',
            [input.email, actor.userId],
          )
        ).rowCount
      )
        throw new ApiError('INVITATION_UNAVAILABLE', 'An invitation cannot be sent to this account.', 409);
      if (
        Number(
          (
            await tx.query(
              "SELECT count(*) AS n FROM group_invitations WHERE group_id=$1 AND created_at>now()-interval '15 minutes'",
              [id],
            )
          ).rows[0].n,
        ) >= 30
      )
        throw new ApiError('INVITE_LIMIT', 'Please wait before sending more group invitations.', 429);
      const token = secret(),
        inviteId = randomUUID();
      await tx.query(
        'INSERT INTO group_invitations(id,group_id,inviter_id,email_hash,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [inviteId, id, actor.userId, hash(input.email), hash(token), group.deadline],
      );
      await notifyBuyer(
        tx,
        this.db.config,
        null,
        input.email,
        'group-invitation',
        'You are invited to a Clubby group',
        `Sign in with this email in Clubby, then accept invitation ${token}.\nGroup: ${group.name}\nDeadline: ${group.deadline.toISOString()}\n${group.terms}`,
        `group-invite:${inviteId}`,
      );
      await audit(
        tx,
        actor.userId,
        'group.invite',
        'group-invitation',
        inviteId,
        'Invited verified email holder',
        { groupId: id },
      );
      return { data: { id: inviteId, token, expiresAt: group.deadline } };
    });
  }
  async accept(actor: Principal, token: string) {
    this.organizations.verified(actor);
    z.string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(token);
    return this.db.transaction(async (tx) => {
      const located = (
        await tx.query('SELECT group_id FROM group_invitations WHERE token_hash=$1', [hash(token)])
      ).rows[0];
      if (!located) throw new ApiError('INVITE_INVALID', 'Invitation is unavailable.', 404);
      const { group } = await this.lock(tx, located.group_id);
      const invitation = (
        await tx.query('SELECT * FROM group_invitations WHERE token_hash=$1 FOR UPDATE', [hash(token)])
      ).rows[0]!;
      if (
        invitation.email_hash !== hash(actor.email!) ||
        invitation.used_at ||
        invitation.revoked_at ||
        invitation.expires_at.getTime() <= Date.now() ||
        group.state !== 'funding'
      )
        throw new ApiError('INVITE_INVALID', 'Invitation is unavailable for this account.', 409);
      const existing = (
        await tx.query('SELECT status FROM group_members WHERE group_id=$1 AND user_id=$2', [
          group.id,
          actor.userId,
        ])
      ).rows[0];
      if (existing?.status === 'removed')
        throw new ApiError('MEMBERSHIP_REMOVED', 'The group owner removed this membership.', 403);
      if (
        existing?.status !== 'active' &&
        Number(
          (
            await tx.query("SELECT count(*) AS n FROM group_members WHERE group_id=$1 AND status='active'", [
              group.id,
            ])
          ).rows[0].n,
        ) >= group.guests
      )
        throw new ApiError('GROUP_FULL', 'All guest places are assigned.', 409);
      await tx.query(
        "INSERT INTO group_members(group_id,user_id) VALUES($1,$2) ON CONFLICT(group_id,user_id) DO UPDATE SET status='active',accepted_terms_at=now()",
        [group.id, actor.userId],
      );
      await tx.query('UPDATE group_invitations SET used_at=now() WHERE id=$1', [invitation.id]);
      await groupEvent(tx, group.id, 'member-joined', { userId: actor.userId });
      return { data: { groupId: group.id, terms: group.terms } };
    });
  }
  async previewInvitation(actor: Principal, token: string) {
    this.organizations.verified(actor);
    z.string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(token);
    const row = (
      await this.db.query(
        'SELECT g.name,g.terms,g.deadline,g.target_minor AS "targetMinor",g.currency,o.snapshot FROM group_invitations i JOIN booking_groups g ON g.id=i.group_id JOIN orders o ON o.id=g.order_id WHERE i.token_hash=$1 AND i.email_hash=$2 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() AND g.state=\'funding\'',
        [hash(token), hash(actor.email!)],
      )
    ).rows[0];
    if (!row) throw new ApiError('INVITE_INVALID', 'Invitation is unavailable for this account.', 404);
    return { data: row };
  }
  async revokeInvite(actor: Principal, groupId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, groupId, actor, true);
      await tx.query(
        'UPDATE group_invitations SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND group_id=$2',
        [id, groupId],
      );
      return { data: { revoked: true } };
    });
  }
  async contribute(actor: Principal, id: string, raw: unknown, key: unknown) {
    const input = z
      .object({ amountMinor: z.number().int().min(50).max(100000000), acceptTerms: z.literal(true) })
      .strict()
      .parse(raw);
    return this.db.transaction((tx) =>
      idempotent(tx, actor.userId, `group.contribute:${id}`, key, input, async () => {
        const { group, order } = await this.lock(tx, id, actor);
        if (
          group.state !== 'funding' ||
          group.deadline.getTime() <= Date.now() ||
          order.cancellation_requested ||
          order.dispute_open
        )
          throw new ApiError('GROUP_CLOSED', 'This group is not accepting contributions.', 409);
        const rows = (
          await tx.query(
            "SELECT o.total_minor,o.commission_minor,o.tax_minor,o.status,c.user_id FROM group_contributions c JOIN orders o ON o.id=c.order_id WHERE c.group_id=$1 AND o.status NOT IN ('cancelled','refunded')",
            [id],
          )
        ).rows;
        if (
          rows.some(
            (r) =>
              r.user_id === actor.userId &&
              ['held', 'payment-pending', 'review', 'refund-pending'].includes(r.status),
          )
        )
          throw new ApiError(
            'CONTRIBUTION_PENDING',
            'Resolve your current contribution before starting another.',
            409,
          );
        if (rows.length >= 100)
          throw new ApiError('CONTRIBUTION_LIMIT', 'This group reached its contribution limit.', 409);
        const remaining = group.target_minor - rows.reduce((sum, r) => sum + r.total_minor, 0);
        if (
          input.amountMinor > remaining ||
          (remaining - input.amountMinor > 0 && remaining - input.amountMinor < 50)
        )
          throw new ApiError(
            'CONTRIBUTION_EXCEEDS_TARGET',
            'Choose an amount within the unreserved target, leaving at least 50 minor units or paying the entire remainder.',
            409,
          );
        const allocated = rows.reduce((sum, r) => sum + r.commission_minor, 0),
          fee =
            input.amountMinor === remaining
              ? order.commission_minor - allocated
              : Math.floor((order.commission_minor * input.amountMinor) / group.target_minor);
        if (fee < 0 || fee > input.amountMinor) throw new Error('Unsafe group application fee allocation.');
        const contributionId = randomUUID(),
          orderId = randomUUID(),
          snapshot = {
            ...order.snapshot,
            table: undefined,
            title: `Group contribution · ${group.name}`,
            group: { id, name: group.name, parentOrderId: order.id, terms: group.terms },
            terms: `${order.snapshot.terms}\n${group.terms}`,
            refundCommission: true,
          };
        const expiry = new Date(Math.min(Date.now() + 10 * 60_000, group.deadline.getTime()));
        await tx.query(
          "INSERT INTO orders(id,user_id,buyer_email_encrypted,buyer_email_hash,occurrence_id,venue_id,organization_id,policy_id,account_id,currency,total_minor,commission_minor,discount_minor,tax_minor,quantity,snapshot,expires_at,payment_role,buyer_accepted_at,channel) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,$13,1,$14,$15,'group-contribution',now(),$16)",
          [
            orderId,
            actor.userId,
            encrypt(actor.email!, this.db.config.encryptionKeys),
            hash(actor.email!),
            order.occurrence_id,
            order.venue_id,
            order.organization_id,
            order.policy_id,
            order.account_id,
            order.currency,
            input.amountMinor,
            fee,
            input.amountMinor === remaining
              ? order.tax_minor - rows.reduce((sum, r) => sum + r.tax_minor, 0)
              : Math.floor((order.tax_minor * input.amountMinor) / group.target_minor),
            JSON.stringify(snapshot),
            expiry,
            actor.channel,
          ],
        );
        await tx.query('INSERT INTO group_contributions(id,group_id,user_id,order_id) VALUES($1,$2,$3,$4)', [
          contributionId,
          id,
          actor.userId,
          orderId,
        ]);
        await groupEvent(tx, id, 'contribution-held', { contributionId });
        return {
          data: {
            id: contributionId,
            orderId,
            amountMinor: input.amountMinor,
            expiresAt: expiry.toISOString(),
          },
        };
      }),
    );
  }
  async withdraw(actor: Principal, groupId: string, contributionId: string) {
    return this.db.transaction(async (tx) => {
      const { group } = await this.lock(tx, groupId, actor);
      if (group.state !== 'funding')
        throw new ApiError('GROUP_CONFIRMED', 'After funding, cancellation applies to the whole table.', 409);
      const order = (
        await tx.query(
          'SELECT o.* FROM group_contributions c JOIN orders o ON o.id=c.order_id WHERE c.id=$1 AND c.group_id=$2 AND c.user_id=$3 FOR UPDATE OF o',
          [contributionId, groupId, actor.userId],
        )
      ).rows[0];
      if (!order) throw new ApiError('NOT_FOUND', 'Your contribution was not found.', 404);
      if (['held', 'payment-pending'].includes(order.status)) {
        await tx.query('UPDATE orders SET cancellation_requested=true WHERE id=$1', [order.id]);
        await enqueue(tx, 'payment.expire', randomUUID(), { orderId: order.id });
      } else if (['paid', 'partially-refunded'].includes(order.status))
        await this.refunds.queue(
          tx,
          order,
          [],
          'Contributor withdrew before the funding target was confirmed',
          actor.userId,
          true,
        );
      else if (!['cancelled', 'refunded', 'refund-pending'].includes(order.status))
        throw new ApiError('PAYMENT_REVIEW', 'Resolve the contribution financial review first.', 409);
      return { data: { withdrawalRequested: true } };
    });
  }
  async cancel(actor: Principal, id: string, reason: string) {
    z.string().min(10).max(1000).parse(reason);
    return this.db.transaction(async (tx) => {
      const { group, order } = await this.lock(tx, id, actor, true);
      if (group.confirmed_at) {
        if (Date.now() > Date.parse(order.snapshot.startsAt) - order.snapshot.refundCutoffHours * 3600_000)
          throw new ApiError('REFUND_CUTOFF', 'Contact booking support after the refund cutoff.', 409);
        if (
          (
            await tx.query(
              'SELECT id FROM tickets WHERE order_id=$1 AND (admitted_at IS NOT NULL OR drinks_used>0)',
              [order.id],
            )
          ).rowCount
        )
          throw new ApiError('TICKET_NOT_REFUNDABLE', 'A guest already used this group booking.', 409);
      }
      await cancelGroup(tx, group, reason);
      return { data: { cancellationRequested: true } };
    });
  }
  async reconcile(id: string) {
    await this.db.transaction(async (tx) => {
      const { group, order } = await this.lock(tx, id);
      await tx.query('UPDATE booking_groups SET checked_at=now() WHERE id=$1', [id]);
      if (['cancelled', 'expired'].includes(group.state)) return;
      const contributions = (
        await tx.query(
          'SELECT o.* FROM group_contributions c JOIN orders o ON o.id=c.order_id WHERE c.group_id=$1 ORDER BY o.id FOR UPDATE OF o',
          [id],
        )
      ).rows;
      if (group.state === 'review' && group.confirmed_at && !order.cancellation_requested) return; // A consumed service needs a reasoned seller decision, not automatic refunds to other members.
      const credited = contributions.filter((c) => c.status === 'paid' && !c.dispute_open);
      const fundedBeforeDeadline =
        credited.reduce((sum, c) => sum + c.total_minor, 0) === group.target_minor &&
        credited.every((c) => c.paid_at && c.paid_at.getTime() <= group.deadline.getTime()) &&
        !contributions.some((c) =>
          ['held', 'payment-pending', 'refund-pending', 'review', 'partially-refunded'].includes(c.status),
        );
      if (
        (group.state === 'funding' || group.state === 'review') &&
        ((group.deadline.getTime() <= Date.now() && !fundedBeforeDeadline) || order.cancellation_requested)
      ) {
        await cancelGroup(
          tx,
          group,
          'Group funding did not complete by its deadline or the event changed.',
          group.deadline.getTime() <= Date.now() ? 'expired' : 'cancelled',
        );
        group.state = 'cancelling';
      }
      if (group.state === 'confirmed') return;
      if (group.state === 'funding' || group.state === 'review') {
        const risky = contributions.some((c) => c.dispute_open || c.status === 'review');
        if (risky) {
          await tx.query("UPDATE booking_groups SET state='review' WHERE id=$1", [id]);
          return;
        }
        if (group.state === 'review')
          await tx.query("UPDATE booking_groups SET state='funding' WHERE id=$1", [id]);
        const partial = contributions.find((c) => c.status === 'partially-refunded');
        if (partial) {
          await this.refunds.queue(
            tx,
            partial,
            [],
            'Return the remainder of a partially refunded group contribution',
            null,
            true,
          );
          return;
        }
        const paid = contributions
          .filter((c) => c.status === 'paid')
          .reduce((sum, c) => sum + c.total_minor, 0);
        if (
          paid !== group.target_minor ||
          contributions.some((c) => ['held', 'payment-pending', 'refund-pending'].includes(c.status))
        )
          return;
        await tx.query(
          "UPDATE booking_groups SET state='confirmed',confirmed_at=now(),version=version+1 WHERE id=$1",
          [id],
        );
        await this.orders.fulfill(tx, order);
        const tickets = (await tx.query('SELECT id FROM tickets WHERE order_id=$1 ORDER BY id', [order.id]))
          .rows;
        const members = (
          await tx.query(
            "SELECT user_id FROM group_members WHERE group_id=$1 AND status='active' ORDER BY joined_at,user_id",
            [id],
          )
        ).rows;
        for (let index = 0; index < members.length; index++) {
          const ticket = tickets[index];
          if (!ticket) throw new Error('Group members exceed table admissions.');
          await tx.query('UPDATE tickets SET owner_id=$1 WHERE id=$2', [members[index]!.user_id, ticket.id]);
          await tx.query(
            'INSERT INTO group_ticket_assignments(group_id,user_id,ticket_id) VALUES($1,$2,$3)',
            [id, members[index]!.user_id, ticket.id],
          );
        }
        await groupEvent(tx, id, 'confirmed');
        await this.notify(
          tx,
          group,
          'confirmed',
          'Your group table is confirmed',
          'Open Clubby to see your admission and the remaining balance.',
        );
        return;
      }
      if (group.state !== 'cancelling') return;
      let unresolved = false;
      for (const contribution of contributions) {
        if (['cancelled', 'refunded'].includes(contribution.status)) continue;
        if (contribution.dispute_open) {
          const disputes = (
            await tx.query('SELECT status,amount_minor FROM provider_disputes WHERE order_id=$1', [
              contribution.id,
            ])
          ).rows;
          const open = disputes.some((d) => !['won', 'warning_closed', 'lost'].includes(d.status));
          if (open) {
            unresolved = true;
            continue;
          }
          const lost = disputes
            .filter((d) => d.status === 'lost')
            .reduce((sum, d) => sum + Number(d.amount_minor), 0);
          const returned = Number(
            (
              await tx.query(
                "SELECT coalesce(sum(amount_minor),0) AS amount FROM refunds WHERE order_id=$1 AND status='succeeded'",
                [contribution.id],
              )
            ).rows[0].amount,
          );
          if (lost + returned >= contribution.total_minor) continue;
          if (lost) {
            contribution.dispute_open = false;
          } else {
            unresolved = true;
            continue;
          }
        }
        unresolved = true;
        if (['held', 'payment-pending'].includes(contribution.status)) {
          await tx.query('UPDATE orders SET cancellation_requested=true WHERE id=$1', [contribution.id]);
          await enqueue(tx, 'payment.expire', `${contribution.id}:group:${Math.floor(Date.now() / 60000)}`, {
            orderId: contribution.id,
          });
        } else if (['paid', 'partially-refunded'].includes(contribution.status))
          await this.refunds.queue(
            tx,
            contribution,
            [],
            group.cancellation_reason ?? 'Group booking cancelled',
            null,
            true,
          );
        // Review and pending refund states retain the allocation until the financial workflow resolves.
      }
      if (unresolved) return;
      const table = (
        await tx.query(
          'SELECT r.*,coalesce((SELECT sum(amount_minor) FROM door_collections WHERE reservation_id=r.id),0)::int AS collected FROM table_reservations r WHERE r.id=$1',
          [group.reservation_id],
        )
      ).rows[0]!;
      if (order.paid_at)
        await journal(
          tx,
          `table-cancel:${table.id}`,
          order.currency,
          order.id,
          'Reverse cancelled group table balance',
          {
            'seller-table-remaining':
              table.status === 'no-show'
                ? table.collected
                : table.full_price_minor - table.online_amount_minor,
            'seller-receivable': -(table.status === 'no-show'
              ? table.collected
              : table.full_price_minor - table.online_amount_minor),
          },
        );
      await tx.query('UPDATE table_reservations SET status=$1 WHERE id=$2', [
        table.collected > 0 ? 'refund-review' : 'cancelled',
        table.id,
      ]);
      await tx.query("UPDATE table_allocations SET status='released' WHERE reservation_id=$1", [table.id]);
      await tx.query("UPDATE inventory_reservations SET status='released' WHERE order_id=$1", [order.id]);
      await tx.query(
        "UPDATE tickets SET status='refunded' WHERE order_id=$1 AND status IN ('valid','refund-pending')",
        [order.id],
      );
      await tx.query('UPDATE orders SET status=$1 WHERE id=$2', [
        order.paid_at ? 'refunded' : 'cancelled',
        order.id,
      ]);
      await tx.query(
        "UPDATE booking_groups SET state=coalesce(cancellation_kind,'cancelled'),version=version+1 WHERE id=$1",
        [id],
      );
      await groupEvent(tx, id, 'cancelled');
      await this.notify(
        tx,
        group,
        'cancelled',
        'Your group booking was cancelled',
        'Contributions are returned to their original payers. A successful bank refund can take time to appear. Any door money is returned separately by the venue.',
      );
    });
  }
  async notify(tx: PoolClient, group: any, kind: string, subject: string, message: string) {
    const members = (
      await tx.query(
        "SELECT u.id,u.email FROM group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1 AND m.status='active' AND u.email IS NOT NULL",
        [group.id],
      )
    ).rows;
    for (const member of members)
      await notifyBuyer(
        tx,
        this.db.config,
        member.id,
        member.email,
        `group-${kind}`,
        subject,
        `${group.name}\n${message}`,
        `group-${kind}:${group.id}:${member.id}`,
        { kind: 'group', id: group.id },
      );
  }
  async sellerReview(actor: Principal, id: string, reason: string) {
    z.string().min(10).max(1000).parse(reason);
    return this.db.transaction(async (tx) => {
      const { group, order } = await this.lock(tx, id);
      await this.organizations.authorize(
        actor,
        order.organization_id,
        'booking.refund',
        order.venue_id,
        false,
        tx,
      );
      if (group.state !== 'review')
        throw new ApiError('REVIEW_UNAVAILABLE', 'The group is not awaiting financial review.', 409);
      await cancelGroup(tx, group, reason);
      await audit(tx, actor.userId, 'group.review.refund', 'group', id, reason);
      return { data: { cancellationRequested: true } };
    });
  }
  async sellerReviews(actor: Principal) {
    this.organizations.verified(actor);
    return {
      data: (
        await this.db.query(
          "SELECT g.id,g.name,g.currency,g.target_minor AS \"targetMinor\",g.state,o.id AS \"orderId\",o.venue_id AS \"venueId\" FROM booking_groups g JOIN orders o ON o.id=g.order_id JOIN memberships m ON m.organization_id=o.organization_id WHERE m.user_id=$1 AND m.status='active' AND m.role IN ('owner','manager') AND (m.venue_ids IS NULL OR o.venue_id=ANY(m.venue_ids)) AND g.state='review' ORDER BY g.created_at LIMIT 100",
          [actor.userId],
        )
      ).rows,
    };
  }
  async leave(actor: Principal, id: string, raw: unknown, targetId = actor.userId) {
    const input = z
      .object({ retainConfirmedContribution: z.boolean(), reason: z.string().min(10).max(1000) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const { group } = await this.lock(tx, id, actor, targetId !== actor.userId);
      if (group.owner_id === targetId)
        throw new ApiError('OWNER_TRANSFER_REQUIRED', 'Transfer ownership before leaving the group.', 409);
      const financial = (
        await tx.query(
          "SELECT o.id FROM group_contributions c JOIN orders o ON o.id=c.order_id WHERE c.group_id=$1 AND c.user_id=$2 AND o.status NOT IN ('cancelled','refunded')",
          [id, targetId],
        )
      ).rowCount;
      if (financial && group.state !== 'confirmed')
        throw new ApiError(
          'WITHDRAW_FIRST',
          'Withdraw and finish refunding this member’s contribution before ending membership.',
          409,
        );
      if (financial && (!input.retainConfirmedContribution || targetId !== actor.userId))
        throw new ApiError(
          'CONTRIBUTION_RETAINED',
          'A funded member must explicitly acknowledge retaining their contribution before leaving.',
          409,
        );
      if (group.state === 'confirmed' && targetId !== actor.userId)
        throw new ApiError(
          'CONFIRMED_MEMBER',
          'Use user blocking or moderation for a confirmed group member; their booking remains valid.',
          409,
        );
      await tx.query('UPDATE group_members SET status=$1 WHERE group_id=$2 AND user_id=$3', [
        targetId === actor.userId ? 'left' : 'removed',
        id,
        targetId,
      ]);
      await tx.query(
        "UPDATE group_owner_transfers SET status='revoked' WHERE group_id=$1 AND status='pending' AND to_user_id=$2",
        [id, targetId],
      );
      await groupEvent(tx, id, 'member-left', { userId: targetId });
      await audit(tx, actor.userId, 'group.member.remove', 'group', id, input.reason, {
        targetId,
        retained: group.state === 'confirmed',
      });
      return { data: { left: true } };
    });
  }
  async offerOwnership(actor: Principal, id: string, targetId: string) {
    return this.db.transaction(async (tx) => {
      const { group } = await this.lock(tx, id, actor, true);
      if (!['funding', 'confirmed'].includes(group.state) || targetId === actor.userId)
        throw new ApiError('TRANSFER_UNAVAILABLE', 'Ownership cannot change in this state.', 409);
      if (
        !(
          await tx.query(
            "SELECT user_id FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='active'",
            [id, targetId],
          )
        ).rowCount
      )
        throw new ApiError('NOT_FOUND', 'Choose a current member.', 404);
      await tx.query(
        "UPDATE group_owner_transfers SET status='revoked' WHERE group_id=$1 AND status='pending'",
        [id],
      );
      const transferId = randomUUID();
      await tx.query(
        'INSERT INTO group_owner_transfers(id,group_id,from_user_id,to_user_id,expires_at) VALUES($1,$2,$3,$4,$5)',
        [transferId, id, actor.userId, targetId, new Date(Date.now() + 15 * 60_000)],
      );
      await groupEvent(tx, id, 'owner-offered', { transferId });
      return { data: { id: transferId } };
    });
  }
  async acceptOwnership(
    actor: Principal,
    id: string,
    transferId: string,
    acceptBalanceResponsibility: boolean,
  ) {
    z.literal(true).parse(acceptBalanceResponsibility);
    return this.db.transaction(async (tx) => {
      const { group } = await this.lock(tx, id, actor);
      if (transferId === 'vacant') {
        const former = (
          await tx.query("SELECT id FROM users WHERE id=$1 AND status IN ('deletion-pending','deleted')", [
            group.owner_id,
          ])
        ).rows[0];
        if (!former || group.state !== 'confirmed')
          throw new ApiError(
            'OWNER_CHANGED',
            'Only a confirmed booking with a deleted owner can be recovered.',
            409,
          );
        await tx.query(
          "UPDATE group_owner_transfers SET status='revoked' WHERE group_id=$1 AND status='pending'",
          [id],
        );
        transferId = randomUUID();
        await tx.query(
          "INSERT INTO group_owner_transfers(id,group_id,from_user_id,to_user_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')",
          [transferId, id, group.owner_id, actor.userId],
        );
      }
      const transfer = (
        await tx.query('SELECT * FROM group_owner_transfers WHERE id=$1 AND group_id=$2 FOR UPDATE', [
          transferId,
          id,
        ])
      ).rows[0];
      if (
        !transfer ||
        transfer.status !== 'pending' ||
        transfer.to_user_id !== actor.userId ||
        transfer.from_user_id !== group.owner_id ||
        transfer.expires_at.getTime() <= Date.now() ||
        !['funding', 'confirmed'].includes(group.state)
      )
        throw new ApiError('TRANSFER_UNAVAILABLE', 'Ownership offer expired or is no longer valid.', 409);
      if (
        group.state === 'funding' &&
        (
          await tx.query(
            "SELECT id FROM booking_groups WHERE owner_id=$1 AND state IN ('funding','review','cancelling') AND id<>$2",
            [actor.userId, id],
          )
        ).rowCount
      )
        throw new ApiError('GROUP_HOLD_LIMIT', 'Finish your other funding group first.', 409);
      await tx.query('UPDATE booking_groups SET owner_id=$1,version=version+1 WHERE id=$2', [
        actor.userId,
        id,
      ]);
      await tx.query(
        'UPDATE orders SET user_id=$1,buyer_email_encrypted=$2,buyer_email_hash=$3 WHERE id=$4',
        [
          actor.userId,
          encrypt(actor.email!, this.db.config.encryptionKeys),
          hash(actor.email!),
          group.order_id,
        ],
      );
      await tx.query(
        'UPDATE tickets SET owner_id=$1 WHERE order_id=$2 AND owner_id=$3 AND id NOT IN (SELECT ticket_id FROM group_ticket_assignments WHERE group_id=$4)',
        [actor.userId, group.order_id, group.owner_id, id],
      );
      await tx.query("UPDATE group_owner_transfers SET status='accepted',accepted_at=now() WHERE id=$1", [
        transferId,
      ]);
      await audit(
        tx,
        actor.userId,
        'group.owner.accept',
        'group',
        id,
        'Accepted remaining balance responsibility and existing group terms',
        { previousOwner: group.owner_id },
      );
      await groupEvent(tx, id, 'owner-changed', { ownerId: actor.userId });
      return { data: { ownerId: actor.userId } };
    });
  }
  async maintenance() {
    await this.db.transaction(async (tx) => {
      const groups = (
        await tx.query(
          "SELECT id FROM booking_groups WHERE state IN ('funding','review','cancelling') ORDER BY checked_at,id LIMIT 200",
        )
      ).rows;
      for (const group of groups)
        await enqueue(tx, 'group.reconcile', `${group.id}:${Math.floor(Date.now() / 60000)}`, {
          groupId: group.id,
        });
      const reminders = (
        await tx.query(
          "SELECT * FROM booking_groups WHERE state='funding' AND reminded_at IS NULL AND deadline>now() AND deadline<now()+interval '5 minutes' ORDER BY deadline LIMIT 200",
        )
      ).rows;
      for (const group of reminders) {
        await this.notify(
          tx,
          group,
          'deadline',
          'Your group funding deadline is approaching',
          'Check the remaining amount in Clubby. Unfinished groups are cancelled and their confirmed contributions refunded.',
        );
        await tx.query('UPDATE booking_groups SET reminded_at=now() WHERE id=$1', [group.id]);
      }
      await tx.query(
        "UPDATE group_messages SET body='',status='deleted' WHERE id IN (SELECT m.id FROM group_messages m JOIN booking_groups g ON g.id=m.group_id JOIN orders o ON o.id=g.order_id JOIN occurrences e ON e.id=o.occurrence_id WHERE m.status<>'deleted' AND e.ends_at<now()-interval '90 days' ORDER BY m.created_at LIMIT 500)",
      );
    });
  }
}
