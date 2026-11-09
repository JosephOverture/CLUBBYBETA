import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { hash } from '../platform/crypto';
import { PrivacyService } from '../privacy/privacy.service';
import { audit } from '../organizations/organizations.service';
import { appleIssuer } from './apple-provider';
const eventSchema = z.object({
  type: z.enum(['email-enabled', 'email-disabled', 'consent-revoked', 'account-deleted', 'account-delete']),
  sub: z.string().min(1).max(256),
  event_time: z.number().int().positive(),
  email: z.string().email().optional(),
  is_private_email: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
});
export class AppleNotificationsService {
  private readonly jwks: JWTVerifyGetKey;
  constructor(
    readonly db: Database,
    readonly privacy: PrivacyService,
    jwks?: JWTVerifyGetKey,
  ) {
    this.jwks = jwks ?? createRemoteJWKSet(new URL(`${appleIssuer}/auth/keys`), { timeoutDuration: 5000 });
  }
  async receive(raw: unknown) {
    if (this.db.config.APPLE_SIGN_IN_ENABLED !== 'true')
      throw new ApiError('NOT_CONFIGURED', 'Apple notifications are not configured.', 503);
    const { payload: token } = z
      .object({ payload: z.string().min(20).max(20000) })
      .strict()
      .parse(raw);
    let id: string, event: z.infer<typeof eventSchema>, occurred: Date;
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: appleIssuer,
        audience: [this.db.config.APPLE_SIGN_IN_IOS_CLIENT_ID!, this.db.config.APPLE_SIGN_IN_WEB_CLIENT_ID!],
        algorithms: ['RS256'],
        requiredClaims: ['iat', 'jti', 'events'],
        maxTokenAge: '7d',
        clockTolerance: 60,
      });
      id = z.string().min(1).max(256).parse(payload.jti);
      event = eventSchema.parse(
        typeof payload.events === 'string' ? JSON.parse(payload.events) : payload.events,
      );
      // Apple's current examples use seconds; older notifications used milliseconds.
      occurred = new Date(event.event_time < 100000000000 ? event.event_time * 1000 : event.event_time);
      if (
        !Number.isFinite(occurred.getTime()) ||
        occurred.getTime() > Date.now() + 60000 ||
        occurred.getTime() > (payload.iat! + 60) * 1000
      )
        throw new Error('Invalid event time');
    } catch {
      throw new ApiError('INVALID_CREDENTIAL', 'Apple notification signature or claims are invalid.', 401);
    }
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,84))', [event.sub]);
      const digest = hash(token),
        subjectHash = hash(event.sub);
      const old = (await tx.query('SELECT payload_hash FROM apple_notification_inbox WHERE id=$1', [id]))
        .rows[0];
      if (old) {
        if (old.payload_hash !== digest)
          throw new ApiError('EVENT_CONFLICT', 'Apple event ID reused with different content.', 409);
        return { data: { accepted: true } };
      }
      await tx.query(
        'INSERT INTO apple_notification_inbox(id,payload_hash,event_type,subject_hash,occurred_at) VALUES($1,$2,$3,$4,$5)',
        [id, digest, event.type, subjectHash, occurred],
      );
      const revoked = ['consent-revoked', 'account-deleted', 'account-delete'].includes(event.type);
      if (revoked)
        await tx.query(
          'INSERT INTO apple_revocations(subject_hash,revoked_at) VALUES($1,$2) ON CONFLICT(subject_hash) DO UPDATE SET revoked_at=greatest(apple_revocations.revoked_at,EXCLUDED.revoked_at),received_at=now()',
          [subjectHash, occurred],
        );
      const identity = (
        await tx.query('SELECT user_id FROM external_identities WHERE issuer=$1 AND subject=$2', [
          appleIssuer,
          event.sub,
        ])
      ).rows[0];
      if (!identity) return { data: { accepted: true } };
      const grant = (
        await tx.query(
          'SELECT max(authenticated_at) AS authenticated_at FROM apple_identity_grants WHERE user_id=$1 AND subject=$2',
          [identity.user_id, event.sub],
        )
      ).rows[0];
      if (grant?.authenticated_at && new Date(grant.authenticated_at).getTime() > occurred.getTime())
        return { data: { accepted: true } };
      if (revoked) {
        // Apple has already invalidated these tokens. Erasure must not depend on revoking
        // them again, but other linked grants/providers still follow the ordinary workflow.
        await tx.query(
          "UPDATE apple_identity_grants SET state='revoked',refresh_encrypted=NULL,updated_at=now() WHERE user_id=$1 AND subject=$2",
          [identity.user_id, event.sub],
        );
        await this.privacy.appleDeletion(tx, identity.user_id);
      } else {
        const user = (
          await tx.query("SELECT email FROM users WHERE id=$1 AND status='active' FOR SHARE", [
            identity.user_id,
          ])
        ).rows[0];
        const email = event.email?.toLowerCase();
        if (
          !email ||
          user?.email !== email ||
          !email.endsWith('@privaterelay.appleid.com') ||
          ![true, 'true'].includes(event.is_private_email ?? false)
        )
          return { data: { accepted: true } };
        await tx.query(
          'INSERT INTO apple_email_preferences(user_id,recipient_hash,disabled,changed_at) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET recipient_hash=EXCLUDED.recipient_hash,disabled=EXCLUDED.disabled,changed_at=EXCLUDED.changed_at WHERE apple_email_preferences.changed_at<EXCLUDED.changed_at OR (apple_email_preferences.changed_at=EXCLUDED.changed_at AND EXCLUDED.disabled)',
          [identity.user_id, hash(email), event.type === 'email-disabled', occurred],
        );
        await audit(
          tx,
          identity.user_id,
          'identity.apple-relay',
          'user',
          identity.user_id,
          'Signed Apple relay preference notification',
          { disabled: event.type === 'email-disabled' },
        );
      }
      return { data: { accepted: true } };
    });
  }
  async maintenance() {
    await this.db.query("DELETE FROM apple_notification_inbox WHERE received_at<now()-interval '30 days'");
    await this.db.query("DELETE FROM apple_revocations WHERE received_at<now()-interval '30 days'");
  }
}
