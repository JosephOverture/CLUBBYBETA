import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { decrypt, encrypt, hash, secret } from '../platform/crypto';
import type { Principal } from '../identity/identity.service';
import { audit, OrganizationsService } from '../organizations/organizations.service';
import { OrdersService } from '../commerce/orders.service';
import { idempotent, notifyBuyer } from '../commerce/core';
import { requireFeature } from '../administration/features';

const emailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export class TransfersService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
    readonly orders: OrdersService,
  ) {}

  async locked(tx: PoolClient, ticketId: string) {
    const location = (await tx.query('SELECT order_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
    if (!location) throw new ApiError('NOT_FOUND', 'Ticket not found.', 404);
    const order = await this.orders.lock(tx, location.order_id);
    const ticket = (await tx.query('SELECT * FROM tickets WHERE id=$1 FOR UPDATE', [ticketId])).rows[0];
    return { order, ticket };
  }
  async eligible(tx: PoolClient, order: any, ticket: any) {
    const occurrence = (await tx.query('SELECT * FROM occurrences WHERE id=$1', [ticket.occurrence_id]))
      .rows[0];
    const table = (await tx.query('SELECT status FROM table_reservations WHERE order_id=$1', [order.id]))
      .rows[0];
    if (
      ticket.status !== 'valid' ||
      ticket.admitted_at ||
      ticket.drinks_used ||
      !['paid', 'partially-refunded'].includes(order.status) ||
      order.dispute_open ||
      order.cancellation_requested ||
      occurrence.status === 'cancelled' ||
      occurrence.starts_at.getTime() <= Date.now() ||
      (table && table.status !== 'confirmed')
    )
      throw new ApiError(
        'TRANSFER_UNAVAILABLE',
        'Only unused, financially active tickets can be transferred before the event starts.',
        409,
      );
    return occurrence;
  }
  async create(actor: Principal, ticketId: string, raw: unknown, key: unknown) {
    this.organizations.verified(actor);
    const input = z.object({ email: emailSchema }).strict().parse(raw);
    if (input.email === actor.email)
      throw new ApiError('INVALID_RECIPIENT', 'Choose another recipient.', 400);
    return this.db.transaction((tx) =>
      idempotent(tx, actor.userId, `ticket.transfer:${ticketId}`, key, input, async () => {
        await requireFeature(tx, 'ticketTransfers');
        const { order, ticket } = await this.locked(tx, ticketId);
        if (ticket.owner_id !== actor.userId) throw new ApiError('NOT_FOUND', 'Ticket not found.', 404);
        const occurrence = await this.eligible(tx, order, ticket);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,73))', [actor.userId]);
        const recent = (
          await tx.query(
            "SELECT count(*)::int AS n FROM ticket_transfers WHERE sender_id=$1 AND created_at>now()-interval '1 day'",
            [actor.userId],
          )
        ).rows[0].n;
        if (recent >= 20)
          throw new ApiError('TRANSFER_LIMIT', 'Too many transfer invitations. Try again tomorrow.', 429);
        if (
          (
            await tx.query(
              'SELECT 1 FROM user_blocks b JOIN users u ON u.id=b.user_id WHERE b.blocked_user_id=$1 AND u.email=$2',
              [actor.userId, input.email],
            )
          ).rowCount
        )
          throw new ApiError('TRANSFER_UNAVAILABLE', 'This transfer invitation cannot be sent.', 409);
        await tx.query(
          "UPDATE ticket_transfers SET status='expired' WHERE ticket_id=$1 AND status='pending' AND expires_at<=now()",
          [ticketId],
        );
        if (
          (
            await tx.query("SELECT 1 FROM ticket_transfers WHERE ticket_id=$1 AND status='pending'", [
              ticketId,
            ])
          ).rowCount
        )
          throw new ApiError(
            'TRANSFER_PENDING',
            'Revoke the existing invitation before sending another.',
            409,
          );
        const id = randomUUID(),
          token = secret(),
          expiresAt = new Date(Math.min(Date.now() + 48 * 3600_000, occurrence.starts_at.getTime()));
        await tx.query(
          'INSERT INTO ticket_transfers(id,ticket_id,sender_id,recipient_email_hash,recipient_email_encrypted,token_hash,token_encrypted,credential_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            id,
            ticketId,
            actor.userId,
            hash(input.email),
            encrypt(input.email, this.db.config.encryptionKeys),
            hash(token),
            encrypt(token, this.db.config.encryptionKeys),
            ticket.credential_version,
            expiresAt,
          ],
        );
        const recipient = (
          await tx.query("SELECT id FROM users WHERE email=$1 AND status='active'", [input.email])
        ).rows[0];
        await notifyBuyer(
          tx,
          this.db.config,
          recipient?.id ?? null,
          input.email,
          'ticket-transfer-invite',
          'A Clubby ticket has been offered to you',
          `Sign in with this email and open Tickets → Accept a transfer.\nInvitation code: ${token}\nExpires: ${expiresAt.toISOString()}\n${order.snapshot.title}\nThe sender keeps access until you accept.`,
          `transfer-invite:${id}`,
        );
        await audit(
          tx,
          actor.userId,
          'ticket.transfer.invite',
          'ticket',
          ticketId,
          'Owner invited a verified recipient',
          { transferId: id },
        );
        return { data: { id, status: 'pending', expiresAt: expiresAt.toISOString() } };
      }),
    );
  }
  async revoke(actor: Principal, id: string) {
    this.organizations.verified(actor);
    return this.db.transaction(async (tx) => {
      const located = (
        await tx.query('SELECT ticket_id FROM ticket_transfers WHERE id=$1 AND sender_id=$2', [
          id,
          actor.userId,
        ])
      ).rows[0];
      if (!located) throw new ApiError('NOT_FOUND', 'Transfer not found.', 404);
      await this.locked(tx, located.ticket_id);
      const changed = await tx.query(
        "UPDATE ticket_transfers SET status='revoked' WHERE id=$1 AND status='pending' RETURNING id",
        [id],
      );
      if (changed.rowCount)
        await audit(
          tx,
          actor.userId,
          'ticket.transfer.revoke',
          'ticket',
          located.ticket_id,
          'Sender revoked invitation',
          { transferId: id },
        );
      return {
        data: {
          id,
          status: (await tx.query('SELECT status FROM ticket_transfers WHERE id=$1', [id])).rows[0].status,
        },
      };
    });
  }
  async invitation(actor: Principal, raw: unknown, accept = false) {
    this.organizations.verified(actor);
    const input = z
      .object({ token: tokenSchema, ...(accept ? { acceptTerms: z.literal(true) } : {}) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const located = (
        await tx.query(
          'SELECT ticket_id FROM ticket_transfers WHERE token_hash=$1 AND recipient_email_hash=$2',
          [hash(input.token), hash(actor.email!)],
        )
      ).rows[0];
      if (!located) throw new ApiError('NOT_FOUND', 'Invitation not found for this verified email.', 404);
      const { order, ticket } = await this.locked(tx, located.ticket_id);
      const invite = (
        await tx.query('SELECT * FROM ticket_transfers WHERE token_hash=$1 FOR UPDATE', [hash(input.token)])
      ).rows[0];
      if (accept && invite.status === 'accepted' && invite.recipient_id === actor.userId)
        return { data: { id: invite.id, ticketId: ticket.id, status: 'accepted' } };
      if (
        invite.status !== 'pending' ||
        invite.expires_at.getTime() <= Date.now() ||
        ticket.owner_id !== invite.sender_id ||
        ticket.credential_version !== invite.credential_version
      )
        throw new ApiError('INVITATION_INACTIVE', 'This invitation is no longer active.', 409);
      await this.eligible(tx, order, ticket);
      if (!accept)
        return {
          data: {
            id: invite.id,
            ticketId: ticket.id,
            title: order.snapshot.title,
            venueName: order.snapshot.venueName,
            terms: order.snapshot.terms,
            tableTerms: order.snapshot.table?.terms ?? null,
            expiresAt: invite.expires_at,
            notice: order.snapshot.table
              ? 'Admission only: the booking owner retains the right to cancel the complete table. Any remaining table balance must be settled before entry.'
              : 'Admission only: payment remains with the buyer. Return this ticket to the buyer to request a self-service refund.',
          },
        };
      const credential = secret();
      await tx.query(
        'UPDATE tickets SET owner_id=$1,credential_hash=$2,credential_encrypted=$3,credential_version=credential_version+1 WHERE id=$4',
        [actor.userId, hash(credential), encrypt(credential, this.db.config.encryptionKeys), ticket.id],
      );
      await tx.query(
        "UPDATE ticket_transfers SET status='accepted',recipient_id=$1,accepted_at=now() WHERE id=$2",
        [actor.userId, invite.id],
      );
      await audit(
        tx,
        actor.userId,
        'ticket.transfer.accept',
        'ticket',
        ticket.id,
        'Verified recipient accepted admission and cancellation terms',
        { transferId: invite.id, previousOwner: invite.sender_id },
      );
      const sender = (await tx.query('SELECT email FROM users WHERE id=$1', [invite.sender_id])).rows[0];
      if (sender?.email)
        await notifyBuyer(
          tx,
          this.db.config,
          invite.sender_id,
          sender.email,
          'ticket-transfer-complete',
          'Your ticket transfer was accepted',
          `${order.snapshot.title}\nThe old QR code no longer grants admission. Payment records remain with the buyer.`,
          `transfer-sender:${invite.id}`,
        );
      await notifyBuyer(
        tx,
        this.db.config,
        actor.userId,
        actor.email!,
        'ticket-transfer-received',
        'Your transferred ticket is ready',
        `${order.snapshot.title}\nOpen Tickets in Clubby to display your new QR code.`,
        `transfer-recipient:${invite.id}`,
        { kind: 'ticket', id: ticket.id },
      );
      return { data: { id: invite.id, ticketId: ticket.id, status: 'accepted' } };
    });
  }
  async list(actor: Principal, before?: string) {
    const cursor = before ? z.string().uuid().parse(before) : null;
    return {
      data: (
        await this.db.query(
          `SELECT t.id,t.status,t.admitted_at AS "admittedAt",o.snapshot->>'title' AS title,
      o.snapshot->>'venueName' AS "venueName",e.starts_at AS "startsAt",e.timezone FROM tickets t JOIN orders o ON o.id=t.order_id
      JOIN occurrences e ON e.id=t.occurrence_id WHERE t.owner_id=$1 AND ($2::uuid IS NULL OR t.id>$2) ORDER BY t.id LIMIT 50`,
          [actor.userId, cursor],
        )
      ).rows,
    };
  }
  async pending(actor: Principal, ticketId: string) {
    const ticket = (
      await this.db.query('SELECT id FROM tickets WHERE id=$1 AND owner_id=$2', [ticketId, actor.userId])
    ).rows[0];
    if (!ticket) throw new ApiError('NOT_FOUND', 'Ticket not found.', 404);
    return {
      data: (
        await this.db.query(
          'SELECT id,status,expires_at AS "expiresAt",recipient_email_encrypted FROM ticket_transfers WHERE ticket_id=$1 AND sender_id=$2 AND status=\'pending\' AND expires_at>now()',
          [ticketId, actor.userId],
        )
      ).rows.map((r) => ({
        id: r.id,
        status: r.status,
        expiresAt: r.expiresAt,
        email: decrypt(r.recipient_email_encrypted, this.db.config.encryptionKeys),
      })),
    };
  }
}
