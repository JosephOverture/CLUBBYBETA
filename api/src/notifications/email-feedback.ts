import { Webhook } from 'svix';
import { z } from 'zod';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { hash } from '../platform/crypto';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import type { Principal } from '../identity/identity.service';
const schema = z.object({
  type: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  data: z.object({ email_id: z.string().min(1).max(200) }),
});
const states: Record<string, string> = {
  'email.sent': 'accepted',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
};
export class EmailFeedbackService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
  ) {}
  async webhook(raw: Buffer | undefined, headers: Record<string, unknown>) {
    if (!raw || !this.db.config.RESEND_WEBHOOK_SECRETS)
      throw new ApiError('WEBHOOK_UNAVAILABLE', 'Email webhook is not configured.', 503);
    const id = z.string().min(1).max(200).parse(headers['svix-id']);
    let verified: unknown;
    for (const secret of this.db.config.RESEND_WEBHOOK_SECRETS.split(',')
      .map((v) => v.trim())
      .filter(Boolean)) {
      try {
        new Webhook(secret).verify(raw.toString('utf8'), {
          'svix-id': id,
          'svix-timestamp': z.string().parse(headers['svix-timestamp']),
          'svix-signature': z.string().parse(headers['svix-signature']),
        });
        // Svix 2 verifies without returning the parsed payload. Parse only after signature verification.
        verified = JSON.parse(raw.toString('utf8'));
        break;
      } catch {}
    }
    if (!verified) throw new ApiError('INVALID_SIGNATURE', 'Email webhook verification failed.', 400);
    const event = schema.safeParse(verified);
    if (!event.success || !states[event.data.type]) return { received: true };
    const inserted = await this.db.query(
      `INSERT INTO email_feedback(id,provider_reference,event_type,occurred_at,payload_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING payload_hash`,
      [id, event.data.data.email_id, event.data.type, event.data.created_at, hash(raw.toString('utf8'))],
    );
    if (inserted.rows[0]?.payload_hash !== hash(raw.toString('utf8')))
      throw new ApiError('WEBHOOK_CONFLICT', 'Email event identity was reused with different data.', 409);
    await this.apply(event.data.data.email_id);
    return { received: true };
  }
  async apply(reference: string) {
    await this.db.transaction(async (tx) => {
      const delivery = (
        await tx.query('SELECT * FROM notification_deliveries WHERE provider_reference=$1 FOR UPDATE', [
          reference,
        ])
      ).rows[0];
      await tx.query('UPDATE email_feedback SET checked_at=now() WHERE provider_reference=$1', [reference]);
      if (!delivery) return;
      // A delayed/accepted replay cannot erase evidence of delivery or a permanent rejection/complaint.
      const event = (
        await tx.query(
          `SELECT * FROM email_feedback WHERE provider_reference=$1 ORDER BY CASE event_type WHEN 'email.complained' THEN 7 WHEN 'email.bounced' THEN 6 WHEN 'email.suppressed' THEN 5 WHEN 'email.delivered' THEN 4 WHEN 'email.failed' THEN 3 WHEN 'email.delivery_delayed' THEN 2 ELSE 1 END DESC,occurred_at DESC,id LIMIT 1`,
          [reference],
        )
      ).rows[0];
      if (!event) return;
      const state = states[event.event_type]!;
      await tx.query('UPDATE notification_deliveries SET delivery_state=$1 WHERE id=$2', [
        state,
        delivery.id,
      ]);
      if (['bounced', 'complained'].includes(state) && delivery.recipient_hash) {
        await tx.query(
          `INSERT INTO email_suppressions(recipient_hash,reason,feedback_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(recipient_hash) DO UPDATE SET reason=EXCLUDED.reason,feedback_id=EXCLUDED.feedback_id,created_at=EXCLUDED.created_at,released_at=NULL,released_by=NULL,release_reason=NULL WHERE email_suppressions.feedback_id<>EXCLUDED.feedback_id AND (email_suppressions.released_at<EXCLUDED.created_at OR (email_suppressions.released_at IS NULL AND (EXCLUDED.reason='complained' AND email_suppressions.reason='bounced' OR EXCLUDED.reason=email_suppressions.reason AND EXCLUDED.created_at>email_suppressions.created_at)))`,
          [delivery.recipient_hash, state, event.id, event.occurred_at],
        );
      }
      await tx.query('UPDATE email_feedback SET applied_at=now() WHERE provider_reference=$1', [reference]);
    });
  }
  async maintenance() {
    const rows = (
      await this.db.query(
        "SELECT provider_reference FROM email_feedback WHERE applied_at IS NULL AND created_at>now()-interval '1 day' GROUP BY provider_reference ORDER BY min(checked_at) NULLS FIRST LIMIT 100",
      )
    ).rows;
    for (const row of rows) await this.apply(row.provider_reference);
  }
  async support(actor: Principal, userId: string) {
    this.organizations.verified(actor);
    if (
      !(
        await this.db.query(
          "SELECT 1 FROM platform_grants WHERE user_id=$1 AND role IN ('admin','support') AND revoked_at IS NULL",
          [actor.userId],
        )
      ).rowCount
    )
      throw new ApiError('FORBIDDEN', 'Support access is required.', 403);
    return {
      data: (
        await this.db.query(
          'SELECT id,kind,category,status,delivery_state AS "deliveryState",created_at AS "createdAt",sent_at AS "sentAt" FROM notification_deliveries WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
          [z.string().uuid().parse(userId)],
        )
      ).rows,
    };
  }
  async release(actor: Principal, raw: unknown) {
    await this.organizations.platform(actor);
    const input = z
      .object({ userId: z.string().uuid(), reason: z.string().trim().min(20).max(1000) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const user = (await tx.query("SELECT email FROM users WHERE id=$1 AND status='active'", [input.userId]))
        .rows[0];
      if (!user?.email) throw new ApiError('NOT_FOUND', 'Active user email not found.', 404);
      await tx.query(
        'UPDATE email_suppressions SET released_at=now(),released_by=$1,release_reason=$2 WHERE recipient_hash=$3 AND released_at IS NULL',
        [actor.userId, input.reason, hash(user.email)],
      );
      await audit(tx, actor.userId, 'email.suppression.release', 'user', input.userId, input.reason);
      return { data: { released: true } };
    });
  }
}
