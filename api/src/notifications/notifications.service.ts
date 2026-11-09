import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { decrypt, encrypt, hash } from '../platform/crypto';
import { enqueue, type TransactionalHandler } from '../platform/jobs';
import type { Principal } from '../identity/identity.service';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import { ApnsProvider, type PushProvider } from './push-provider';
import { notifyBuyer } from '../commerce/core';
export const notificationTarget = z.object({
  kind: z.enum(['booking', 'group', 'ticket', 'support']),
  id: z.string().uuid(),
});
export const preferenceInput = z
  .object({
    locale: z.enum(['en', 'it']),
    timezone: z.string().refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Use an IANA timezone.'),
    destinationId: z
      .string()
      .regex(/^[a-z0-9-]{1,100}$/)
      .nullable(),
    bookingEmail: z.boolean(),
    marketingEmail: z.boolean(),
    bookingPush: z.boolean(),
    marketingPush: z.boolean(),
    chatPush: z.boolean(),
    expectedVersion: z.number().int().min(0),
  })
  .strict();
export class NotificationsService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
    readonly push: PushProvider = new ApnsProvider(db.config),
  ) {}
  async preferences(actor: Principal) {
    const r = (await this.db.query('SELECT * FROM user_preferences WHERE user_id=$1', [actor.userId]))
      .rows[0];
    return {
      data: {
        locale: r?.locale ?? 'en',
        timezone: r?.timezone ?? 'Europe/Rome',
        destinationId: r?.destination_id ?? null,
        bookingEmail: r?.booking_email ?? true,
        marketingEmail: r?.marketing_email ?? false,
        bookingPush: r?.booking_push ?? true,
        marketingPush: r?.marketing_push ?? false,
        chatPush: r?.chat_push ?? true,
        version: r?.version ?? 0,
        pushAvailable: this.db.config.APPLE_PUSH_ENABLED === 'true',
      },
    };
  }
  async updatePreferences(actor: Principal, raw: unknown) {
    const input = preferenceInput.parse(raw);
    this.organizations.verified(actor);
    await this.db.transaction(async (tx) => {
      if (
        input.destinationId &&
        !(await tx.query('SELECT id FROM destinations WHERE id=$1 AND published=true', [input.destinationId]))
          .rowCount
      )
        throw new ApiError('INVALID_DESTINATION', 'Choose an available destination.', 400);
      const values = [
        actor.userId,
        input.locale,
        input.timezone,
        input.destinationId,
        input.bookingEmail,
        input.marketingEmail,
        input.bookingPush,
        input.marketingPush,
        input.chatPush,
      ];
      const changed =
        input.expectedVersion === 0
          ? await tx.query(
              `INSERT INTO user_preferences(user_id,locale,timezone,destination_id,booking_email,marketing_email,booking_push,marketing_push,chat_push) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id) DO NOTHING RETURNING version`,
              values,
            )
          : await tx.query(
              `UPDATE user_preferences SET locale=$2,timezone=$3,destination_id=$4,booking_email=$5,marketing_email=$6,booking_push=$7,marketing_push=$8,chat_push=$9,version=version+1,updated_at=now() WHERE user_id=$1 AND version=$10 RETURNING version`,
              [...values, input.expectedVersion],
            );
      if (!changed.rowCount)
        throw new ApiError('VERSION_CONFLICT', 'Preferences changed. Refresh before saving.', 409);
      await audit(
        tx,
        actor.userId,
        'preferences.update',
        'user',
        actor.userId,
        'Account holder updated communication preferences',
        {
          version: changed.rows[0].version,
          marketingEmail: input.marketingEmail,
          marketingPush: input.marketingPush,
          consentVersion: 1,
        },
      );
    });
    return this.preferences(actor);
  }
  private async permitted(tx: PoolClient, row: any, push = false) {
    if (!row.user_id) return !push && !['marketing', 'collaboration'].includes(row.category);
    const user = (await tx.query('SELECT status FROM users WHERE id=$1', [row.user_id])).rows[0];
    if (user?.status !== 'active') return false;
    if (
      row.kind === 'event-reminder' &&
      !(
        await tx.query(
          `SELECT 1 FROM tickets t JOIN occurrences e ON e.id=t.occurrence_id JOIN orders o ON o.id=t.order_id WHERE t.id=$1 AND t.owner_id=$2 AND t.status='valid' AND t.admitted_at IS NULL AND e.status<>'cancelled' AND e.starts_at>now() AND o.status IN ('paid','partially-refunded','refund-pending') AND NOT o.dispute_open AND NOT o.cancellation_requested`,
          [row.target?.id, row.user_id],
        )
      ).rowCount
    )
      return false;
    const p = (await tx.query('SELECT * FROM user_preferences WHERE user_id=$1', [row.user_id])).rows[0];
    if (row.category === 'security') return !push;
    if (row.category === 'marketing') return Boolean(push ? p?.marketing_push : p?.marketing_email);
    if (row.category === 'collaboration') {
      if (!push || row.target?.kind !== 'group') return false;
      return (
        (p?.chat_push ?? true) &&
        Boolean(
          (
            await tx.query(
              "SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='active'",
              [row.target.id, row.user_id],
            )
          ).rowCount,
        )
      );
    }
    return push ? (p?.booking_push ?? true) : (p?.booking_email ?? true);
  }
  publish: TransactionalHandler = async (tx, payload) => {
    const { deliveryId } = z.object({ deliveryId: z.string().uuid() }).parse(payload);
    const row = (await tx.query('SELECT * FROM notification_deliveries WHERE id=$1', [deliveryId])).rows[0];
    if (!row || row.category === 'security') return;
    if (
      row.category === 'marketing' &&
      !(await this.permitted(tx, row)) &&
      !(await this.permitted(tx, row, true))
    )
      return;
    await tx.query('INSERT INTO inapp_notifications(delivery_id) VALUES($1) ON CONFLICT DO NOTHING', [
      deliveryId,
    ]);
    if (
      !row.user_id ||
      !(await this.permitted(tx, row, true)) ||
      this.db.config.APPLE_PUSH_ENABLED !== 'true'
    )
      return;
    const devices = (
      await tx.query(
        `SELECT d.id,d.generation FROM push_devices d JOIN sessions s ON s.id=d.session_id WHERE d.user_id=$1 AND d.status='active' AND s.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM refresh_tokens r WHERE r.session_id=s.id AND r.used_at IS NULL AND r.expires_at>now())`,
        [row.user_id],
      )
    ).rows;
    for (const device of devices) {
      const sent = (
        await tx.query(
          `INSERT INTO push_deliveries(id,delivery_id,device_id,generation) VALUES($1,$2,$3,$4) ON CONFLICT(delivery_id,device_id,generation) DO NOTHING RETURNING id`,
          [randomUUID(), deliveryId, device.id, device.generation],
        )
      ).rows[0];
      if (sent) await enqueue(tx, 'notification.push', sent.id, { pushId: sent.id });
    }
  };
  async mayEmail(id: string) {
    return this.db.transaction(async (tx) => {
      const row = (await tx.query('SELECT * FROM notification_deliveries WHERE id=$1', [id])).rows[0];
      if (!row) return false;
      if (row.status === 'suppressed') return false;
      if (
        (
          await tx.query('SELECT 1 FROM apple_email_preferences WHERE recipient_hash=$1 AND disabled', [
            row.recipient_hash,
          ])
        ).rowCount
      )
        return false;
      const suppressed = (
        await tx.query('SELECT 1 FROM email_suppressions WHERE recipient_hash=$1 AND released_at IS NULL', [
          row.recipient_hash,
        ])
      ).rowCount;
      return !suppressed && (await this.permitted(tx, row));
    });
  }
  async reminders() {
    await this.db.transaction(async (tx) => {
      // One reminder per holder/event/schedule; exclusion before LIMIT keeps a busy batch progressing.
      const rows = (
        await tx.query(`SELECT DISTINCT ON (e.id,t.owner_id) t.id AS ticket_id,t.owner_id,u.email,e.starts_at,e.timezone,o.snapshot,
        'reminder:'||e.id::text||':'||t.owner_id::text||':'||(extract(epoch from e.starts_at)*1000)::bigint::text AS dedupe
        FROM tickets t JOIN users u ON u.id=t.owner_id JOIN occurrences e ON e.id=t.occurrence_id JOIN orders o ON o.id=t.order_id
        WHERE t.status='valid' AND t.admitted_at IS NULL AND u.status='active' AND u.email IS NOT NULL AND e.status<>'cancelled'
        AND e.starts_at BETWEEN now()+interval '1 hour' AND now()+interval '24 hours' AND o.status IN ('paid','partially-refunded','refund-pending') AND NOT o.dispute_open AND NOT o.cancellation_requested
        AND NOT EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.dedupe_key='reminder:'||e.id::text||':'||t.owner_id::text||':'||(extract(epoch from e.starts_at)*1000)::bigint::text)
        ORDER BY e.id,t.owner_id,t.id LIMIT 100`)
      ).rows;
      for (const r of rows)
        await notifyBuyer(
          tx,
          this.db.config,
          r.owner_id,
          r.email,
          'event-reminder',
          'Your Clubby event is coming up',
          `${r.snapshot.title}\n${new Intl.DateTimeFormat('en', { timeZone: r.timezone, dateStyle: 'full', timeStyle: 'short' }).format(r.starts_at)} (${r.timezone})\nOpen your ticket in Clubby to check the current schedule, entry conditions and any table balance.`,
          r.dedupe,
          { kind: 'ticket', id: r.ticket_id },
        );
    });
  }
  async inbox(actor: Principal, before?: string) {
    const cursor = before
      ? z
          .string()
          .regex(/^[0-9]{1,19}$/)
          .parse(before)
      : '9223372036854775807';
    const rows = (
      await this.db.query(
        `SELECT d.*,n.sequence::text,n.read_at FROM inapp_notifications n JOIN notification_deliveries d ON d.id=n.delivery_id WHERE d.user_id=$1 AND n.hidden_at IS NULL AND n.sequence<$2 ORDER BY n.sequence DESC LIMIT 50`,
        [actor.userId, cursor],
      )
    ).rows;
    return {
      data: rows.map((r) => {
        const content = z
          .object({ subject: z.string(), text: z.string() })
          .parse(decrypt(r.encrypted_payload, this.db.config.encryptionKeys));
        return {
          id: r.id,
          sequence: r.sequence,
          kind: r.kind,
          category: r.category,
          title: content.subject,
          text: content.text,
          target: r.target,
          readAt: r.read_at,
          createdAt: r.created_at,
          emailState: r.delivery_state,
        };
      }),
      meta: { nextCursor: rows.length === 50 ? rows.at(-1)!.sequence : null },
    };
  }
  async read(actor: Principal, id: string) {
    const changed = await this.db.query(
      `UPDATE inapp_notifications n SET read_at=coalesce(read_at,now()) FROM notification_deliveries d WHERE d.id=n.delivery_id AND d.user_id=$1 AND n.delivery_id=$2 RETURNING n.delivery_id`,
      [actor.userId, z.string().uuid().parse(id)],
    );
    if (!changed.rowCount) throw new ApiError('NOT_FOUND', 'Notification not found.', 404);
    return { data: { id, read: true } };
  }
  async detail(actor: Principal, id: string) {
    const row = (
      await this.db.query(
        `SELECT d.*,n.read_at,n.sequence::text FROM inapp_notifications n JOIN notification_deliveries d ON d.id=n.delivery_id WHERE d.id=$1 AND d.user_id=$2 AND n.hidden_at IS NULL`,
        [z.string().uuid().parse(id), actor.userId],
      )
    ).rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'Notification not found.', 404);
    const content = z
      .object({ subject: z.string(), text: z.string() })
      .parse(decrypt(row.encrypted_payload, this.db.config.encryptionKeys));
    return {
      data: {
        id: row.id,
        sequence: row.sequence,
        kind: row.kind,
        category: row.category,
        title: content.subject,
        text: content.text,
        target: row.target,
        readAt: row.read_at,
        createdAt: row.created_at,
        emailState: row.delivery_state,
      },
    };
  }
  async register(actor: Principal, raw: unknown) {
    this.organizations.verified(actor);
    if (actor.channel !== 'ios' || this.db.config.APPLE_PUSH_ENABLED !== 'true')
      throw new ApiError('PUSH_UNAVAILABLE', 'iOS push is unavailable for this session.', 409);
    const input = z
      .object({
        installationId: z.string().uuid(),
        token: z.string().regex(/^[a-f0-9]{32,256}$/i),
        environment: z.enum(['sandbox', 'production']),
      })
      .strict()
      .parse(raw);
    if (input.environment !== this.db.config.APPLE_PUSH_ENVIRONMENT)
      throw new ApiError('PUSH_ENVIRONMENT', 'This build uses a different push environment.', 409);
    const tokenHash = hash(input.token.toLowerCase());
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,79))', [actor.userId]);
      for (const key of [input.installationId, tokenHash].sort())
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,78))', [key]);
      const session = (
        await tx.query(
          'SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',
          [actor.sessionId, actor.userId],
        )
      ).rows[0];
      if (!session) throw new ApiError('UNAUTHORIZED', 'Sign in again before enabling push.', 401);
      await tx.query(
        "UPDATE push_devices SET status='revoked',generation=generation+1 WHERE token_hash=$1 AND installation_id<>$2 AND status='active'",
        [tokenHash, input.installationId],
      );
      const existing = (
        await tx.query('SELECT id FROM push_devices WHERE installation_id=$1', [input.installationId])
      ).rows[0];
      if (
        (!existing ||
          !(
            await tx.query("SELECT 1 FROM push_devices WHERE id=$1 AND user_id=$2 AND status='active'", [
              existing.id,
              actor.userId,
            ])
          ).rowCount) &&
        (
          await tx.query("SELECT count(*)::int n FROM push_devices WHERE user_id=$1 AND status='active'", [
            actor.userId,
          ])
        ).rows[0].n >= 10
      )
        throw new ApiError('DEVICE_LIMIT', 'Remove an existing push device before adding another.', 429);
      const row = (
        await tx.query(
          `INSERT INTO push_devices(id,installation_id,user_id,session_id,token_hash,token_encrypted,environment) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(installation_id) DO UPDATE SET user_id=EXCLUDED.user_id,session_id=EXCLUDED.session_id,token_hash=EXCLUDED.token_hash,token_encrypted=EXCLUDED.token_encrypted,environment=EXCLUDED.environment,status='active',generation=CASE WHEN push_devices.user_id=EXCLUDED.user_id AND push_devices.session_id=EXCLUDED.session_id AND push_devices.token_hash=EXCLUDED.token_hash AND push_devices.status='active' THEN push_devices.generation ELSE push_devices.generation+1 END,updated_at=now() RETURNING id,generation`,
          [
            randomUUID(),
            input.installationId,
            actor.userId,
            actor.sessionId,
            tokenHash,
            encrypt(input.token.toLowerCase(), this.db.config.encryptionKeys),
            input.environment,
          ],
        )
      ).rows[0];
      return { data: row };
    });
  }
  async devices(actor: Principal) {
    return {
      data: (
        await this.db.query(
          'SELECT id,created_at AS "createdAt",updated_at AS "updatedAt",(session_id=$2) AS current FROM push_devices WHERE user_id=$1 AND status=\'active\' ORDER BY created_at DESC',
          [actor.userId, actor.sessionId],
        )
      ).rows,
    };
  }
  async unregister(actor: Principal, id: string) {
    await this.db.query(
      "UPDATE push_devices SET status='revoked',generation=generation+1,updated_at=now() WHERE id=$1 AND user_id=$2",
      [z.string().uuid().parse(id), actor.userId],
    );
    return { data: { removed: true } };
  }
  async sendPush(id: string) {
    const row = await this.db.transaction(async (tx) => {
      const r = (
        await tx.query(
          `SELECT p.*,d.user_id,d.kind,d.category,d.target,v.user_id AS device_user,v.token_encrypted,v.status AS device_status,v.generation AS current_generation,s.revoked_at,
        EXISTS(SELECT 1 FROM refresh_tokens r WHERE r.session_id=s.id AND r.used_at IS NULL AND r.expires_at>now()) AS session_active
        FROM push_deliveries p JOIN notification_deliveries d ON d.id=p.delivery_id JOIN push_devices v ON v.id=p.device_id JOIN sessions s ON s.id=v.session_id WHERE p.id=$1`,
          [id],
        )
      ).rows[0];
      if (!r || r.status !== 'queued') return null;
      if (
        r.device_status !== 'active' ||
        r.generation !== r.current_generation ||
        r.device_user !== r.user_id ||
        r.revoked_at ||
        !r.session_active ||
        !(await this.permitted(tx, r, true))
      ) {
        await tx.query("UPDATE push_deliveries SET status='suppressed' WHERE id=$1", [id]);
        return null;
      }
      return r;
    });
    if (!row) return;
    const outcome = await this.push.send(
      decrypt(row.token_encrypted, this.db.config.encryptionKeys) as string,
      row.delivery_id,
      id,
    );
    await this.db.transaction(async (tx) => {
      await tx.query('UPDATE push_deliveries SET status=$1,sent_at=now() WHERE id=$2', [outcome, id]);
      if (outcome === 'unregistered')
        await tx.query(
          "UPDATE push_devices SET status='revoked',generation=generation+1 WHERE id=$1 AND generation=$2",
          [row.device_id, row.generation],
        );
    });
  }
}
