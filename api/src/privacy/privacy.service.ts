import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../platform/config';
import { Database } from '../platform/database';
import { encrypt, decrypt, hash, secret, equalHash } from '../platform/crypto';
import { enqueue, type TransactionalHandler } from '../platform/jobs';
import { ApiError } from '../platform/http';
import { audit, OrganizationsService } from '../organizations/organizations.service';
import type { Principal } from '../identity/identity.service';
import type { PoolClient } from 'pg';

type ErasureProviders = {
  erasePayments(userId: string): Promise<void>;
  revokeApple(userId: string): Promise<void>;
  eraseMedia(assetId: string): Promise<void>;
  eraseLocalMail?(userId: string): Promise<void>;
};

export class PrivacyService {
  constructor(
    readonly db: Database,
    private readonly config: Config,
    private readonly providers?: ErasureProviders,
  ) {}
  async request(actor: Principal, raw: unknown) {
    const input = z
      .object({ kind: z.enum(['export', 'delete']), confirmConsequences: z.boolean().optional() })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`privacy:${actor.userId}`]);
      const user = (
        await tx.query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE", [actor.userId])
      ).rows[0];
      if (!user) throw new ApiError('INVALID_CREDENTIAL', 'Account unavailable.', 401);
      if (input.kind === 'delete' && input.confirmConsequences !== true)
        throw new ApiError(
          'CONFIRM_DELETION',
          'Confirm loss of account access and unused personal admissions. Deletion does not request refunds or cancel financial obligations.',
          400,
        );
      const previous = await tx.query(
        'SELECT id,status,receipt_encrypted FROM privacy_requests WHERE user_id=$1 AND kind=$2 AND status IN ($3,$4,$5)',
        [actor.userId, input.kind, 'pending', 'processing', 'review-required'],
      );
      if (previous.rows[0])
        return {
          data: {
            id: previous.rows[0].id,
            status: previous.rows[0].status,
            receipt: previous.rows[0].receipt_encrypted
              ? (decrypt(previous.rows[0].receipt_encrypted, this.config.encryptionKeys) as string)
              : undefined,
          },
        };
      if (
        input.kind === 'export' &&
        Number(
          (
            await tx.query(
              "SELECT count(*) FROM privacy_requests WHERE user_id=$1 AND kind='export' AND created_at>now()-interval '1 day'",
              [actor.userId],
            )
          ).rows[0].count,
        ) >= 3
      )
        throw new ApiError('RATE_LIMITED', 'Request up to three exports per day.', 429);
      const id = randomUUID();
      const receipt = secret();
      await tx.query(
        'INSERT INTO privacy_requests(id,user_id,kind,receipt_hash,receipt_encrypted) VALUES($1,$2,$3,$4,$5)',
        [id, actor.userId, input.kind, hash(receipt), encrypt(receipt, this.config.encryptionKeys)],
      );
      await enqueue(tx, 'privacy.process', id, { requestId: id });
      await audit(
        tx,
        actor.userId,
        `privacy.${input.kind}`,
        'privacy-request',
        id,
        'Requested by account holder',
      );
      return { data: { id, status: 'pending', receipt } };
    });
  }
  async status(actor: Principal, id: string) {
    const result = await this.db.query(
      'SELECT id,kind,status,created_at AS "createdAt",completed_at AS "completedAt",due_at AS "dueAt",expires_at AS "expiresAt",error_code AS "errorCode" FROM privacy_requests WHERE id=$1 AND user_id=$2',
      [z.string().uuid().parse(id), actor.userId],
    );
    if (!result.rows[0]) throw new ApiError('NOT_FOUND', 'Privacy request not found.', 404);
    return { data: result.rows[0] };
  }
  async export(actor: Principal, id: string) {
    const result = await this.db.query<{ result_encrypted: string }>(
      'SELECT result_encrypted FROM privacy_requests WHERE id=$1 AND user_id=$2 AND kind=$3 AND status=$4 AND result_encrypted IS NOT NULL AND expires_at>now()',
      [z.string().uuid().parse(id), actor.userId, 'export', 'completed'],
    );
    if (!result.rows[0]) throw new ApiError('NOT_FOUND', 'Export is not ready or does not exist.', 404);
    return { data: decrypt(result.rows[0].result_encrypted, this.config.encryptionKeys) };
  }
  handler: TransactionalHandler = async (tx, payload) => {
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(payload);
    const selected = await tx.query<{ id: string; user_id: string; kind: string; status: string }>(
      'SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE',
      [requestId],
    );
    const request = selected.rows[0];
    if (!request || request.status === 'completed') return;
    if (request.kind === 'export') {
      const active = await tx.query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE", [
        request.user_id,
      ]);
      if (!active.rowCount) {
        await tx.query(
          "UPDATE privacy_requests SET status='completed',completed_at=now(),result_encrypted=NULL,error_code='ACCOUNT_DELETED' WHERE id=$1",
          [requestId],
        );
        return;
      }
      const profile = await tx.query('SELECT id,email,display_name,kind,created_at FROM users WHERE id=$1', [
        request.user_id,
      ]);
      const memberships = await tx.query(
        'SELECT organization_id,role,status,venue_ids FROM memberships WHERE user_id=$1',
        [request.user_id],
      );
      const identities = await tx.query(
        'SELECT issuer,subject,created_at FROM external_identities WHERE user_id=$1',
        [request.user_id],
      );
      const saved = await tx.query('SELECT venue_id,created_at FROM saved_venues WHERE user_id=$1', [
        request.user_id,
      ]);
      const claims = await tx.query(
        'SELECT id,venue_id,organization_id,evidence,status,created_at FROM venue_claims WHERE applicant_id=$1',
        [request.user_id],
      );
      const authoredMedia = await tx.query(
        'SELECT id,venue_id,event_id,alt_text,status,created_at FROM media_assets WHERE actor_id=$1',
        [request.user_id],
      );
      const bookings = await tx.query(
        'SELECT id,occurrence_id,status,total_minor,currency,quantity,snapshot,created_at FROM orders WHERE user_id=$1',
        [request.user_id],
      );
      const tickets = await tx.query(
        'SELECT id,order_id,status,admitted_at,drinks_total,drinks_used FROM tickets WHERE owner_id=$1',
        [request.user_id],
      );
      const tableReservations = await tx.query(
        'SELECT r.id,r.order_id,r.status,r.snapshot FROM table_reservations r JOIN orders o ON o.id=r.order_id WHERE o.user_id=$1',
        [request.user_id],
      );
      const doorCollections = await tx.query(
        'SELECT c.id,c.reservation_id,c.amount_minor,c.method,c.reference,c.reason,c.reversal_of,c.created_at FROM door_collections c JOIN table_reservations r ON r.id=c.reservation_id JOIN orders o ON o.id=r.order_id WHERE o.user_id=$1 OR c.actor_id=$1',
        [request.user_id],
      );
      const messages = await tx.query(
        'SELECT case_id,body,created_at FROM support_messages WHERE actor_id=$1',
        [request.user_id],
      );
      const groupMemberships = await tx.query(
        'SELECT m.group_id,m.status,m.accepted_terms_at,g.name,g.terms,g.deadline,g.state FROM group_members m JOIN booking_groups g ON g.id=m.group_id WHERE m.user_id=$1',
        [request.user_id],
      );
      const groupMessages = await tx.query(
        'SELECT id,group_id,body,status,created_at FROM group_messages WHERE author_id=$1',
        [request.user_id],
      );
      const messageReports = await tx.query(
        'SELECT id,message_id,reason,status,resolution,created_at FROM message_reports WHERE reporter_id=$1',
        [request.user_id],
      );
      const blockedUsers = await tx.query(
        'SELECT blocked_user_id,created_at FROM user_blocks WHERE user_id=$1',
        [request.user_id],
      );
      await tx.query(
        "UPDATE privacy_requests SET status='completed',completed_at=now(),expires_at=now()+interval '7 days',result_encrypted=$1 WHERE id=$2",
        [
          encrypt(
            {
              profile: profile.rows[0],
              memberships: memberships.rows,
              identities: identities.rows,
              savedVenues: saved.rows,
              venueClaims: claims.rows,
              authoredMedia: authoredMedia.rows,
              bookings: bookings.rows,
              tickets: tickets.rows,
              tableReservations: tableReservations.rows,
              doorCollections: doorCollections.rows,
              supportMessages: messages.rows,
              groupMemberships: groupMemberships.rows,
              groupMessages: groupMessages.rows,
              messageReports: messageReports.rows,
              blockedUsers: blockedUsers.rows,
              preferences: (
                await tx.query(
                  'SELECT locale,timezone,destination_id,booking_email,booking_push,chat_push,marketing_email,marketing_push FROM user_preferences WHERE user_id=$1',
                  [request.user_id],
                )
              ).rows,
              notifications: (
                await tx.query(
                  'SELECT kind,category,target,status,created_at FROM notification_deliveries WHERE user_id=$1',
                  [request.user_id],
                )
              ).rows,
              paymentConsent: (
                await tx.query(
                  'SELECT p.order_id,p.save_card,p.card_consent_at,p.card_save_status FROM payment_attempts p JOIN orders o ON o.id=p.order_id WHERE o.user_id=$1',
                  [request.user_id],
                )
              ).rows,
              transfers: (
                await tx.query(
                  'SELECT id,ticket_id,status,created_at,accepted_at FROM ticket_transfers WHERE sender_id=$1 OR recipient_id=$1',
                  [request.user_id],
                )
              ).rows,
              retention: (
                await tx.query(
                  'SELECT scope,legal_basis,expires_at FROM privacy_holds WHERE user_id=$1 AND released_at IS NULL AND expires_at>now()',
                  [request.user_id],
                )
              ).rows,
            },
            this.config.encryptionKeys,
          ),
          requestId,
        ],
      );
    } else {
      await this.beginDeletion(tx, request.user_id, requestId);
      return;
    }
    await audit(
      tx,
      request.user_id,
      'privacy.processed',
      'privacy-request',
      requestId,
      'Privacy workflow completed',
      { kind: request.kind },
    );
  };

  async list(actor: Principal) {
    return {
      data: (
        await this.db.query(
          'SELECT id,kind,status,created_at AS "createdAt",due_at AS "dueAt",expires_at AS "expiresAt" FROM privacy_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
          [actor.userId],
        )
      ).rows,
    };
  }
  async receipt(raw: unknown) {
    const input = z
      .object({ id: z.string().uuid(), receipt: z.string().min(40).max(100) })
      .strict()
      .parse(raw);
    const row = (
      await this.db.query(
        'SELECT id,kind,status,receipt_hash,due_at AS "dueAt",completed_at AS "completedAt",error_code AS "errorCode" FROM privacy_requests WHERE id=$1',
        [input.id],
      )
    ).rows[0];
    if (!row || !row.receipt_hash || !equalHash(input.receipt, row.receipt_hash))
      throw new ApiError('NOT_FOUND', 'Privacy receipt not found.', 404);
    const { receipt_hash: _, ...data } = row;
    return { data };
  }
  private async beginDeletion(tx: PoolClient, userId: string, requestId: string) {
    // The same lock as platform grants/ownership prevents deletion from racing a transfer.
    await tx.query('SELECT pg_advisory_xact_lock(42819209)');
    await tx.query(
      "UPDATE users SET status='deletion-pending',version=version+1 WHERE id=$1 AND status<>'deleted'",
      [userId],
    );
    await tx.query('UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1', [userId]);
    await tx.query(
      "UPDATE organizations o SET privacy_sales_paused=true,version=version+1 WHERE EXISTS(SELECT 1 FROM memberships m WHERE m.organization_id=o.id AND m.user_id=$1 AND m.role='owner' AND m.status='active') AND NOT EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=o.id AND m.user_id<>$1 AND m.role='owner' AND m.status='active' AND u.status='active')",
      [userId],
    );
    await tx.query("UPDATE memberships SET status='revoked' WHERE user_id=$1", [userId]);
    await tx.query(
      'UPDATE platform_grants SET revoked_at=coalesce(revoked_at,now()),version=version+1 WHERE user_id=$1',
      [userId],
    );
    await tx.query("UPDATE privacy_requests SET status='processing',error_code=NULL WHERE id=$1", [
      requestId,
    ]);
    const requestVersion = (await tx.query('SELECT version FROM privacy_requests WHERE id=$1', [requestId]))
      .rows[0].version;
    await enqueue(tx, 'privacy.erase', requestVersion === 1 ? requestId : `${requestId}:${requestVersion}`, {
      requestId,
    });
    await audit(
      tx,
      userId,
      'privacy.deletion-started',
      'privacy-request',
      requestId,
      'Account access revoked; provider erasure queued',
    );
  }
  async appleDeletion(tx: PoolClient, userId: string) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`privacy:${userId}`]);
    const previous = (
      await tx.query(
        "SELECT id,status FROM privacy_requests WHERE user_id=$1 AND kind='delete' AND status IN ('pending','processing','review-required') FOR UPDATE",
        [userId],
      )
    ).rows[0];
    if (previous) {
      if (previous.status === 'pending') await this.beginDeletion(tx, userId, previous.id);
      return;
    }
    if ((await tx.query("SELECT id FROM users WHERE id=$1 AND status='deleted'", [userId])).rowCount) return;
    const id = randomUUID();
    await tx.query("INSERT INTO privacy_requests(id,user_id,kind) VALUES($1,$2,'delete')", [id, userId]);
    await audit(
      tx,
      userId,
      'privacy.apple-request',
      'privacy-request',
      id,
      'Signed Apple consent revocation or account deletion notification',
    );
    await this.beginDeletion(tx, userId, id);
  }
  async erase(requestId: string) {
    const request = (
      await this.db.query(
        "SELECT * FROM privacy_requests WHERE id=$1 AND kind='delete' AND status IN ('processing','review-required')",
        [requestId],
      )
    ).rows[0];
    if (!request) return;
    if (!this.providers) throw new Error('Privacy provider adapters are required.');
    // Idempotent remote calls, outside database transactions; failures remain retryable and visible.
    await this.providers.erasePayments(request.user_id);
    await this.providers.revokeApple(request.user_id);
    await this.providers.eraseLocalMail?.(request.user_id);
    const media = (
      await this.db.query(
        "UPDATE media_assets SET status='deleted',alt_text='' WHERE actor_id=$1 RETURNING id",
        [request.user_id],
      )
    ).rows;
    for (const asset of media) await this.providers.eraseMedia(asset.id);
    await this.db.transaction(async (tx) => {
      const current = (await tx.query('SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE', [requestId]))
        .rows[0];
      if (current.status === 'completed') return;
      const userId = current.user_id;
      const user = (await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
      if (!['deletion-pending', 'deleted'].includes(user.status))
        throw new Error('Deletion account must remain disabled.');
      const holds = (
        await tx.query(
          'SELECT * FROM privacy_holds WHERE user_id=$1 AND released_at IS NULL AND expires_at>now() FOR UPDATE',
          [userId],
        )
      ).rows;
      for (const hold of holds) {
        if (hold.retained_encrypted) continue;
        const retained =
          hold.scope === 'profile'
            ? { email: user.email, displayName: user.display_name }
            : hold.scope === 'support'
              ? (
                  await tx.query(
                    'SELECT id,case_id,body,created_at FROM support_messages WHERE actor_id=$1',
                    [userId],
                  )
                ).rows
              : (
                  await tx.query(
                    'SELECT id,group_id,body,created_at FROM group_messages WHERE author_id=$1',
                    [userId],
                  )
                ).rows;
        await tx.query('UPDATE privacy_holds SET retained_encrypted=$1 WHERE id=$2', [
          encrypt(retained, this.config.encryptionKeys),
          hold.id,
        ]);
      }
      const emailHash = hash(user.email ?? `deleted:${userId}`);
      const blank = encrypt('', this.config.encryptionKeys);
      await tx.query('DELETE FROM login_challenges WHERE email=$1', [user.email]);
      await tx.query('DELETE FROM apple_login_challenges WHERE link_user_id=$1', [userId]);
      await tx.query('DELETE FROM external_identities WHERE user_id=$1', [userId]);
      await tx.query('DELETE FROM apple_email_preferences WHERE user_id=$1', [userId]);
      await tx.query('DELETE FROM apple_identity_grants WHERE user_id=$1 AND state=$2', [userId, 'revoked']);
      await tx.query('DELETE FROM saved_venues WHERE user_id=$1', [userId]);
      await tx.query('DELETE FROM user_preferences WHERE user_id=$1', [userId]);
      await tx.query('DELETE FROM user_blocks WHERE user_id=$1 OR blocked_user_id=$1', [userId]);
      await tx.query('DELETE FROM api_idempotency WHERE user_id=$1', [userId]);
      await tx.query('UPDATE orders SET buyer_email_encrypted=$1,buyer_email_hash=$2 WHERE user_id=$3', [
        blank,
        hash(`deleted:${userId}`),
        userId,
      ]);
      const pending = (
        await tx.query(
          "UPDATE orders SET cancellation_requested=true WHERE user_id=$1 AND status IN ('held','payment-pending') AND payment_role<>'group-reservation' RETURNING id",
          [userId],
        )
      ).rows;
      for (const order of pending)
        await enqueue(tx, 'payment.expire', `privacy:${order.id}`, { orderId: order.id });
      // Funding groups settle/refund through their existing reconciliation workflow. Confirmed
      // contributions and other members' tickets remain intact; a member can accept vacant ownership.
      const groups = (
        await tx.query(
          "UPDATE orders o SET cancellation_requested=true FROM booking_groups g WHERE g.order_id=o.id AND g.owner_id=$1 AND g.confirmed_at IS NULL AND g.state IN ('funding','review') RETURNING g.id",
          [userId],
        )
      ).rows;
      for (const group of groups)
        await enqueue(tx, 'group.reconcile', `privacy:${group.id}`, { groupId: group.id });
      await tx.query("UPDATE group_members SET status='left' WHERE user_id=$1", [userId]);
      await tx.query("UPDATE group_messages SET body='',status='deleted' WHERE author_id=$1", [userId]);
      await tx.query("UPDATE booking_groups SET name='Group booking',version=version+1 WHERE owner_id=$1", [
        userId,
      ]);
      await tx.query(
        "UPDATE message_reports SET reason='Removed on account deletion',resolution=CASE WHEN resolution IS NULL THEN NULL ELSE 'Removed on account deletion' END WHERE reporter_id=$1",
        [userId],
      );
      await tx.query("UPDATE support_messages SET body='[Removed on account deletion]' WHERE actor_id=$1", [
        userId,
      ]);
      await tx.query("UPDATE support_cases SET subject='Booking support' WHERE user_id=$1", [userId]);
      await tx.query("UPDATE venue_claims SET evidence='Removed on account deletion' WHERE applicant_id=$1", [
        userId,
      ]);
      await tx.query(
        "UPDATE staff_invitations SET email='deleted-'||id::text||'@invalid',revoked_at=coalesce(revoked_at,now()) WHERE email=$1 OR inviter_id=$2",
        [user.email, userId],
      );
      await tx.query(
        'UPDATE group_invitations SET revoked_at=coalesce(revoked_at,now()),email_hash=$1 WHERE inviter_id=$2 OR email_hash=$3',
        [hash(`deleted:${userId}`), userId, emailHash],
      );
      await tx.query(
        "UPDATE group_owner_transfers SET status='revoked' WHERE status='pending' AND (from_user_id=$1 OR to_user_id=$1)",
        [userId],
      );
      await tx.query(
        "UPDATE organization_owner_transfers SET state='revoked' WHERE state='pending' AND (from_user_id=$1 OR to_user_id=$1 OR created_by=$1)",
        [userId],
      );
      await tx.query(
        "UPDATE ticket_transfers SET status=CASE WHEN status='pending' THEN 'revoked' ELSE status END,recipient_email_encrypted=$1,token_encrypted=$1,recipient_email_hash=$2 WHERE sender_id=$3 OR recipient_id=$3 OR recipient_email_hash=$4",
        [blank, hash(`deleted:${userId}`), userId, emailHash],
      );
      await tx.query(
        "UPDATE push_devices SET status='revoked',token_encrypted=$1,token_hash='deleted:'||id::text,generation=generation+1 WHERE user_id=$2",
        [blank, userId],
      );
      await tx.query(
        "UPDATE notification_deliveries SET status='suppressed',delivery_state='suppressed',encrypted_payload=$1,recipient_hash=NULL WHERE user_id=$2 OR recipient_hash=$3",
        [encrypt({}, this.config.encryptionKeys), userId, emailHash],
      );
      await tx.query(
        "UPDATE report_exports SET result_encrypted=NULL,status='expired' WHERE requested_by=$1",
        [userId],
      );
      await tx.query(
        'UPDATE payment_attempts SET client_secret_encrypted=NULL WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)',
        [userId],
      );
      await tx.query(
        'UPDATE privacy_requests SET result_encrypted=NULL,receipt_encrypted=NULL WHERE user_id=$1',
        [userId],
      );
      await tx.query(
        "UPDATE users SET status='deleted',email=NULL,email_verified_at=NULL,display_name='',version=version+1,updated_at=now() WHERE id=$1",
        [userId],
      );
      await tx.query(
        "UPDATE privacy_requests SET status='completed',completed_at=now(),error_code=NULL WHERE id=$1",
        [requestId],
      );
      await audit(
        tx,
        userId,
        'privacy.processed',
        'privacy-request',
        requestId,
        'Personal account erased; pseudonymous financial and audit records retained',
        { holds: holds.map((h) => h.id) },
      );
    });
  }
  async operations(actor: Principal) {
    await new OrganizationsService(this.db, this.config).platform(actor);
    return {
      data: (
        await this.db.query(
          "SELECT id,user_id,kind,status,due_at,error_code,version,due_at<now() AS overdue FROM privacy_requests WHERE status<>'completed' ORDER BY due_at LIMIT 100",
        )
      ).rows,
    };
  }
  async retry(actor: Principal, id: string, raw: unknown) {
    const input = z
      .object({ expectedVersion: z.number().int().positive(), reason: z.string().min(10).max(1000) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await new OrganizationsService(this.db, this.config).platformAny(actor, ['admin'], tx);
      const row = (
        await tx.query('SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE', [z.string().uuid().parse(id)])
      ).rows[0];
      if (!row || row.version !== input.expectedVersion || row.status !== 'review-required')
        throw new ApiError('VERSION_CONFLICT', 'Privacy request changed or does not need retry.', 409);
      await tx.query(
        "UPDATE privacy_requests SET status='pending',version=version+1,error_code=NULL WHERE id=$1",
        [id],
      );
      // New attempt key preserves exhausted-job evidence; operator retries never hide prior failures.
      await enqueue(tx, 'privacy.process', `${id}:${row.version + 1}`, { requestId: id });
      await audit(tx, actor.userId, 'privacy.retry', 'privacy-request', id, input.reason);
      return { data: { queued: true } };
    });
  }
  async hold(actor: Principal, userId: string, raw: unknown) {
    const input = z
      .object({
        scope: z.enum(['profile', 'support', 'chat']),
        legalBasis: z.string().min(20).max(2000),
        reference: z.string().min(5).max(200),
        expiresAt: z.string().datetime(),
      })
      .strict()
      .parse(raw);
    const expires = new Date(input.expiresAt);
    if (expires.getTime() <= Date.now() || expires.getTime() > Date.now() + 366 * 86400000)
      throw new ApiError('INVALID_EXPIRY', 'Retention requires a future review date within one year.', 400);
    return this.db.transaction(async (tx) => {
      await new OrganizationsService(this.db, this.config).platformAny(actor, ['admin'], tx);
      const user = (
        await tx.query('SELECT status FROM users WHERE id=$1 FOR UPDATE', [z.string().uuid().parse(userId)])
      ).rows[0];
      if (!user || user.status === 'deleted')
        throw new ApiError('NOT_FOUND', 'Account data has already been erased or does not exist.', 404);
      const id = randomUUID();
      await tx.query(
        'INSERT INTO privacy_holds(id,user_id,scope,legal_basis,reference,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, userId, input.scope, input.legalBasis, input.reference, expires, actor.userId],
      );
      await audit(
        tx,
        actor.userId,
        'privacy.hold',
        'privacy-hold',
        id,
        'Documented legal retention restriction',
        { scope: input.scope, expiresAt: input.expiresAt },
      );
      return { data: { id } };
    });
  }
  async holds(actor: Principal, userId: string) {
    await new OrganizationsService(this.db, this.config).platform(actor);
    return {
      data: (
        await this.db.query(
          'SELECT id,scope,legal_basis,reference,expires_at,released_at,erased_at FROM privacy_holds WHERE user_id=$1 ORDER BY created_at',
          [z.string().uuid().parse(userId)],
        )
      ).rows,
    };
  }
  async releaseHold(actor: Principal, id: string, raw: unknown) {
    const { reason } = z
      .object({ reason: z.string().min(10).max(1000) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await new OrganizationsService(this.db, this.config).platformAny(actor, ['admin'], tx);
      const result = await tx.query(
        'UPDATE privacy_holds SET released_at=coalesce(released_at,now()),released_by=$1,retained_encrypted=NULL,erased_at=now() WHERE id=$2 RETURNING id',
        [actor.userId, z.string().uuid().parse(id)],
      );
      if (!result.rowCount) throw new ApiError('NOT_FOUND', 'Retention restriction not found.', 404);
      await audit(tx, actor.userId, 'privacy.hold-release', 'privacy-hold', id, reason);
      return { data: { released: true } };
    });
  }
  async retained(actor: Principal, id: string, raw: unknown) {
    const { reason } = z
      .object({ reason: z.string().min(10).max(1000) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await new OrganizationsService(this.db, this.config).platformAny(actor, ['admin'], tx);
      const row = (
        await tx.query(
          'SELECT retained_encrypted FROM privacy_holds WHERE id=$1 AND released_at IS NULL AND expires_at>now() AND retained_encrypted IS NOT NULL FOR SHARE',
          [z.string().uuid().parse(id)],
        )
      ).rows[0];
      if (!row) throw new ApiError('NOT_FOUND', 'Retained copy unavailable or expired.', 404);
      await audit(tx, actor.userId, 'privacy.retained-access', 'privacy-hold', id, reason);
      return { data: decrypt(row.retained_encrypted, this.config.encryptionKeys) };
    });
  }
  async maintenance() {
    await this.db.transaction(async (tx) => {
      await tx.query(
        'UPDATE privacy_requests SET result_encrypted=NULL WHERE expires_at<=now() AND result_encrypted IS NOT NULL',
      );
      await tx.query(
        'UPDATE privacy_holds SET retained_encrypted=NULL,erased_at=now() WHERE (expires_at<=now() OR released_at IS NOT NULL) AND erased_at IS NULL',
      );
      await tx.query(
        "UPDATE privacy_requests p SET status='review-required',error_code='ERASURE_RETRY_REQUIRED' WHERE p.status IN ('pending','processing') AND EXISTS(SELECT 1 FROM outbox_jobs j WHERE j.topic IN ('privacy.process','privacy.erase') AND j.dedupe_key=CASE WHEN p.version=1 THEN p.id::text ELSE p.id::text||':'||p.version::text END AND j.status='dead')",
      );
      await tx.query(
        "DELETE FROM wallet_downloads WHERE pass_id IN (SELECT w.id FROM wallet_passes w JOIN users u ON u.id=w.owner_id WHERE u.status='deleted')",
      );
      // Keep pass update credentials until the provider has been notified that the pass is invalid.
      await tx.query(
        "DELETE FROM wallet_registrations WHERE pass_id IN (SELECT w.id FROM wallet_passes w JOIN users u ON u.id=w.owner_id WHERE u.status='deleted' AND (NOT w.apple_requested OR w.apple_notified_revision>=w.revision) AND (NOT w.google_requested OR w.google_synced_revision>=w.revision))",
      );
    });
  }
}
