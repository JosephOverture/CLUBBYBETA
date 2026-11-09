import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import type { Principal } from '../identity/identity.service';
import { decrypt, hash } from '../platform/crypto';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import { idempotent } from './core';
import { OrdersService } from './orders.service';

export class AdmissionsService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
    readonly orders: OrdersService,
  ) {}
  async ticket(actor: Principal, id: string) {
    const value = (
      await this.db.query(
        `SELECT t.*,o.snapshot,o.dispute_open,o.cancellation_requested,o.status AS order_status,e.status AS occurrence_status,e.starts_at,e.ends_at FROM tickets t JOIN orders o ON o.id=t.order_id JOIN occurrences e ON e.id=t.occurrence_id WHERE t.id=$1 AND t.owner_id=$2`,
        [z.string().uuid().parse(id), actor.userId],
      )
    ).rows[0];
    if (!value) throw new ApiError('NOT_FOUND', 'Ticket not found.', 404);
    return {
      data: {
        id: value.id,
        orderId: value.order_id,
        occurrenceId: value.occurrence_id,
        status: value.status,
        admittedAt: value.admitted_at,
        drinksTotal: value.drinks_total,
        drinksUsed: value.drinks_used,
        snapshot: value.snapshot,
        currentSchedule: {
          startsAt: value.snapshot.table?.slotStartsAt ?? value.starts_at,
          endsAt: value.snapshot.table?.slotEndsAt ?? value.ends_at,
        },
        credential:
          value.status === 'valid' &&
          value.order_status !== 'review' &&
          !value.dispute_open &&
          !value.cancellation_requested &&
          value.occurrence_status !== 'cancelled'
            ? decrypt(value.credential_encrypted, this.db.config.encryptionKeys)
            : null,
      },
    };
  }
  async scan(actor: Principal, raw: unknown, key: unknown) {
    const input = z
      .object({
        occurrenceId: z.string().uuid(),
        credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        kind: z.enum(['admission', 'drink']),
      })
      .strict()
      .parse(raw);
    // Do not persist the QR secret in idempotency data or audit metadata.
    const safe = { ...input, credential: hash(input.credential) };
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM occurrences WHERE id=$1 FOR UPDATE', [input.occurrenceId]);
      const occurrence = (
        await tx.query(
          'SELECT o.*,e.venue_id FROM occurrences o JOIN events e ON e.id=o.event_id WHERE o.id=$1',
          [input.occurrenceId],
        )
      ).rows[0];
      if (!occurrence) throw new ApiError('NOT_FOUND', 'Occurrence not found.', 404);
      await this.organizations.authorizeVenue(actor, occurrence.venue_id, 'admissions.redeem', tx);
      return idempotent(tx, actor.userId, 'admission.scan', key, safe, async () => {
        const located = (
          await tx.query('SELECT id,occurrence_id FROM tickets WHERE credential_hash=$1', [safe.credential])
        ).rows[0];
        const ticket =
          located?.occurrence_id === input.occurrenceId
            ? (
                await tx.query(
                  'SELECT t.*,o.dispute_open,o.cancellation_requested,o.status AS order_status,u.status AS holder_status FROM tickets t JOIN orders o ON o.id=t.order_id JOIN users u ON u.id=t.owner_id WHERE t.credential_hash=$1 FOR UPDATE OF t,o FOR SHARE OF u',
                  [safe.credential],
                )
              ).rows[0]
            : located;
        let outcome = 'invalid';
        const table = ticket?.order_id
          ? (
              await tx.query(
                'SELECT r.*,coalesce((SELECT sum(c.amount_minor) FROM door_collections c WHERE c.reservation_id=r.id),0)::int AS collected FROM table_reservations r WHERE r.order_id=$1',
                [ticket.order_id],
              )
            ).rows[0]
          : null;
        if (ticket) {
          if (ticket.occurrence_id !== input.occurrenceId) outcome = 'wrong-event';
          else if (occurrence.status === 'cancelled' || ticket.cancellation_requested) outcome = 'cancelled';
          else if (
            ticket.status !== 'valid' ||
            ticket.holder_status !== 'active' ||
            ticket.dispute_open ||
            ticket.order_status === 'review'
          )
            outcome = 'inactive';
          else if (table && table.status !== 'confirmed') outcome = 'inactive';
          else if (table && table.full_price_minor - table.online_amount_minor - table.collected > 0)
            outcome = 'balance-due';
          else if (
            table &&
            (Date.now() < Date.parse(table.snapshot.slotStartsAt) - 30 * 60_000 ||
              Date.now() > Date.parse(table.snapshot.slotEndsAt))
          )
            outcome = 'outside-table-slot';
          else if (
            Date.now() < occurrence.starts_at.getTime() - 6 * 3600_000 ||
            Date.now() > occurrence.ends_at.getTime() + 6 * 3600_000
          )
            outcome = 'outside-admission-window';
          else if (input.kind === 'admission') {
            if (ticket.admitted_at) outcome = 'already-admitted';
            else {
              outcome = 'accepted';
              await tx.query('UPDATE tickets SET admitted_at=now() WHERE id=$1', [ticket.id]);
            }
          } else if (!ticket.admitted_at) outcome = 'admission-required';
          else if (ticket.drinks_used >= ticket.drinks_total) outcome = 'drinks-exhausted';
          else {
            outcome = 'accepted';
            await tx.query('UPDATE tickets SET drinks_used=drinks_used+1 WHERE id=$1', [ticket.id]);
          }
        }
        const id = randomUUID();
        await tx.query(
          'INSERT INTO admission_scans(id,actor_id,ticket_id,occurrence_id,kind,outcome) VALUES($1,$2,$3,$4,$5,$6)',
          [
            id,
            actor.userId,
            ticket?.occurrence_id === input.occurrenceId ? ticket.id : null,
            input.occurrenceId,
            input.kind,
            outcome,
          ],
        );
        return {
          data: {
            scanId: id,
            outcome,
            tableReservationId: table?.id ?? null,
            ticketId: ticket?.occurrence_id === input.occurrenceId ? ticket.id : null,
          },
        };
      });
    });
  }
  async lookup(actor: Principal, venueId: string, orderId: string, reason: string) {
    await this.organizations.authorizeVenue(actor, venueId, 'booking.read');
    const order = (
      await this.db.query('SELECT * FROM orders WHERE id=$1 AND venue_id=$2', [
        z.string().uuid().parse(orderId),
        venueId,
      ])
    ).rows[0];
    if (!order) throw new ApiError('NOT_FOUND', 'Booking not found.', 404);
    await this.db.transaction((tx) =>
      audit(tx, actor.userId, 'booking.lookup', 'order', orderId, z.string().min(10).max(1000).parse(reason)),
    );
    return { data: await this.orders.present(order) };
  }
  async assigned(actor: Principal) {
    this.organizations.verified(actor);
    return {
      data: (
        await this.db.query(
          `SELECT DISTINCT o.id,e.title,v.name AS "venueName",o.starts_at AS "startsAt" FROM occurrences o JOIN events e ON e.id=o.event_id JOIN venues v ON v.id=e.venue_id JOIN memberships m ON m.organization_id=v.organization_id JOIN organizations org ON org.id=m.organization_id WHERE m.user_id=$1 AND m.status='active' AND org.status='approved' AND m.role IN ('owner','manager','door') AND (m.venue_ids IS NULL OR v.id=ANY(m.venue_ids)) AND o.status<>'cancelled' AND o.starts_at<now()+interval '36 hours' AND o.ends_at>now()-interval '6 hours' ORDER BY o.starts_at,o.id LIMIT 100`,
          [actor.userId],
        )
      ).rows,
    };
  }
  async summary(actor: Principal, id: string) {
    const event = (
      await this.db.query(
        'SELECT e.venue_id FROM occurrences o JOIN events e ON e.id=o.event_id WHERE o.id=$1',
        [id],
      )
    ).rows[0];
    if (!event) throw new ApiError('NOT_FOUND', 'Occurrence not found.', 404);
    await this.organizations.authorizeVenue(actor, event.venue_id, 'admissions.redeem');
    return {
      data: (
        await this.db.query(
          'SELECT count(*) FILTER(WHERE admitted_at IS NOT NULL)::int AS admissions,coalesce(sum(drinks_used),0)::int AS drinks_redeemed FROM tickets WHERE occurrence_id=$1',
          [id],
        )
      ).rows[0],
    };
  }
  async manual(actor: Principal, raw: unknown, key: unknown) {
    const input = z
      .object({ ticketId: z.string().uuid(), reason: z.string().min(10).max(1000) })
      .strict()
      .parse(raw);
    return this.db.transaction((tx) =>
      idempotent(tx, actor.userId, 'admission.manual', key, input, async () => {
        const location = (await tx.query('SELECT order_id FROM tickets WHERE id=$1', [input.ticketId]))
          .rows[0];
        if (!location) throw new ApiError('NOT_FOUND', 'Ticket not found.', 404);
        const order = await this.orders.lock(tx, location.order_id);
        await this.organizations.authorizeVenue(actor, order.venue_id, 'event.publish', tx);
        const ticket = (await tx.query('SELECT * FROM tickets WHERE id=$1 FOR UPDATE', [input.ticketId]))
          .rows[0]!;
        const occurrence = (
          await tx.query('SELECT status FROM occurrences WHERE id=$1', [ticket.occurrence_id])
        ).rows[0]!;
        const holder = (await tx.query('SELECT status FROM users WHERE id=$1 FOR SHARE', [ticket.owner_id]))
          .rows[0];
        if (
          ticket.status !== 'valid' ||
          holder?.status !== 'active' ||
          order.dispute_open ||
          order.cancellation_requested ||
          order.status === 'review' ||
          occurrence.status === 'cancelled'
        )
          throw new ApiError(
            'TICKET_INACTIVE',
            'An override cannot admit an inactive account or a refunded, cancelled or disputed booking.',
            409,
          );
        const table = (
          await tx.query(
            'SELECT r.*,coalesce((SELECT sum(c.amount_minor) FROM door_collections c WHERE c.reservation_id=r.id),0)::int AS collected FROM table_reservations r WHERE r.order_id=$1',
            [order.id],
          )
        ).rows[0];
        if (
          table &&
          (table.status !== 'confirmed' ||
            table.full_price_minor - table.online_amount_minor - table.collected > 0)
        )
          throw new ApiError(
            'TABLE_BALANCE_DUE',
            'A manual override cannot bypass table payment or reservation state.',
            409,
          );
        if (ticket.admitted_at)
          throw new ApiError('ALREADY_ADMITTED', 'This ticket has already been admitted.', 409);
        await tx.query('UPDATE tickets SET admitted_at=now() WHERE id=$1', [ticket.id]);
        const id = randomUUID();
        await tx.query(
          "INSERT INTO admission_scans(id,actor_id,ticket_id,occurrence_id,kind,outcome) VALUES($1,$2,$3,$4,'admission','manual-accepted')",
          [id, actor.userId, ticket.id, ticket.occurrence_id],
        );
        await audit(tx, actor.userId, 'admission.override', 'ticket', ticket.id, input.reason);
        return { data: { scanId: id, outcome: 'accepted', ticketId: ticket.id } };
      }),
    );
  }
}
