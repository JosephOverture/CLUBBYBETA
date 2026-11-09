import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { Database } from '../platform/database';
import type { Config } from '../platform/config';
import { ApiError } from '../platform/http';
import { secret, hash, equalHash, challengeHash, encrypt } from '../platform/crypto';
import { enqueue } from '../platform/jobs';

const verifier = z.string().regex(/^[A-Za-z0-9_~-]{43,128}$/);
const channel = z.enum(['web', 'ios']);
const challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const loginStartSchema = z
  .object({
    email: z
      .string()
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    challenge,
    channel,
  })
  .strict();
const completeSchema = z
  .object({ challengeId: z.string().uuid(), token: z.string().min(40).max(100), verifier })
  .strict();
export type Principal = {
  userId: string;
  sessionId: string;
  kind: 'guest' | 'registered';
  email: string | null;
  channel: 'web' | 'ios';
  csrfHash: string;
};
export type Credentials = {
  token: string;
  csrfToken: string;
  refreshToken?: string;
  channel: 'web' | 'ios';
  userId: string;
  expiresAt: string;
};
export type IdentityRequest = FastifyRequest & { principal?: Principal };

export class IdentityService {
  private readonly jwks?: JWTVerifyGetKey;
  constructor(
    readonly db: Database,
    readonly config: Config,
    jwks?: JWTVerifyGetKey,
  ) {
    this.jwks =
      jwks ??
      (config.OIDC_JWKS_URL
        ? createRemoteJWKSet(new URL(config.OIDC_JWKS_URL), { timeoutDuration: 5000 })
        : undefined);
  }
  cookieName() {
    return ['development', 'test'].includes(this.config.APP_ENV) ? 'clubby_session' : '__Host-clubby_session';
  }
  async requireRecent(actor: Principal) {
    const fresh = await this.db.query(
      "SELECT id FROM sessions WHERE id=$1 AND created_at>now()-interval '15 minutes' AND revoked_at IS NULL",
      [actor.sessionId],
    );
    if (!fresh.rowCount)
      throw new ApiError('REAUTHENTICATION_REQUIRED', 'Sign in again to confirm this action.', 403);
  }
  async start(raw: unknown) {
    if (this.config.EMAIL_MODE === 'disabled')
      throw new ApiError('NOT_CONFIGURED', 'Email sign-in is not available.', 503);
    const input = loginStartSchema.parse(raw);
    const id = randomUUID();
    const token = secret();
    await this.db.transaction(async (tx) => {
      // Serialize by normalized address to enforce a cross-instance delivery limit.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 19))', [input.email]);
      const recent = await tx.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM login_challenges WHERE email=$1 AND created_at > now()-interval '15 minutes'",
        [input.email],
      );
      if ((recent.rows[0]?.count ?? 0) >= 5) return; // Same public response; do not disclose account existence/rate state.
      await tx.query(
        `INSERT INTO login_challenges(id,email,token_hash,verifier_hash,channel,expires_at)
        VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes')`,
        [id, input.email, hash(token), input.challenge, input.channel],
      );
      const deliveryId = randomUUID();
      await tx.query(
        `INSERT INTO notification_deliveries(id,kind,encrypted_payload,recipient_hash) VALUES($1,'sign-in',$2,$3)`,
        [
          deliveryId,
          encrypt(
            {
              to: input.email,
              subject: 'Your Clubby sign-in code',
              text: `Enter this code in the Clubby app or website where you requested it:\n\n${token}\n\nIt expires in 15 minutes. If you did not request it, ignore this email.`,
            },
            this.config.encryptionKeys,
          ),
          hash(input.email),
        ],
      );
      await enqueue(tx, 'notification.deliver', deliveryId, { deliveryId });
    });
    return { data: { challengeId: id, accepted: true } };
  }
  async complete(raw: unknown): Promise<Credentials> {
    const input = completeSchema.parse(raw);
    const result = await this.db.transaction(async (tx) => {
      const selected = await tx.query<{
        email: string;
        token_hash: string;
        verifier_hash: string;
        channel: 'web' | 'ios';
        valid: boolean;
      }>(
        `
        SELECT *, (used_at IS NULL AND expires_at > now()) AS valid FROM login_challenges WHERE id=$1 FOR UPDATE`,
        [input.challengeId],
      );
      const row = selected.rows[0];
      if (
        !row?.valid ||
        !equalHash(input.token, row.token_hash) ||
        challengeHash(input.verifier) !== row.verifier_hash
      )
        return null;
      const user = await tx.query<{ id: string; status: string }>(
        `INSERT INTO users(id,email,email_verified_at,kind)
        VALUES($1,$2,now(),'registered') ON CONFLICT(email) DO UPDATE SET updated_at=now() RETURNING id,status`,
        [randomUUID(), row.email],
      );
      const actor = user.rows[0]!;
      if (actor.status !== 'active') return null;
      await tx.query('UPDATE notification_deliveries SET user_id=$1 WHERE recipient_hash=$2', [
        actor.id,
        hash(row.email),
      ]);
      await tx.query('UPDATE login_challenges SET used_at=now() WHERE id=$1', [input.challengeId]);
      return this.issue(tx, actor.id, row.channel);
    });
    if (!result) throw new ApiError('INVALID_CREDENTIAL', 'Sign-in code is invalid or expired.', 401);
    return result;
  }
  async issue(
    tx: PoolClient,
    userId: string,
    clientChannel: 'web' | 'ios',
    sessionId: string = randomUUID(),
  ): Promise<Credentials> {
    const token = secret(),
      csrfToken = secret();
    const expiresAt = new Date(
      Date.now() + (clientChannel === 'web' ? 8 * 3600_000 : 15 * 60_000),
    ).toISOString();
    await tx.query(
      `INSERT INTO sessions(id,user_id,token_hash,csrf_hash,channel,expires_at,csrf_encrypted) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO UPDATE SET token_hash=EXCLUDED.token_hash,csrf_hash=EXCLUDED.csrf_hash,expires_at=EXCLUDED.expires_at,csrf_encrypted=EXCLUDED.csrf_encrypted`,
      [
        sessionId,
        userId,
        hash(token),
        hash(csrfToken),
        clientChannel,
        expiresAt,
        encrypt(csrfToken, this.config.encryptionKeys),
      ],
    );
    const refreshToken = clientChannel === 'ios' ? secret() : undefined;
    if (refreshToken)
      await tx.query(
        "INSERT INTO refresh_tokens(token_hash,session_id,expires_at) VALUES($1,$2,now()+interval '30 days')",
        [hash(refreshToken), sessionId],
      );
    return { token, csrfToken, refreshToken, channel: clientChannel, userId, expiresAt };
  }
  async guest(raw: unknown) {
    const input = z.object({ channel }).strict().parse(raw);
    return this.db.transaction(async (tx) => {
      const id = randomUUID();
      await tx.query("INSERT INTO users(id,kind) VALUES($1,'guest')", [id]);
      return this.issue(tx, id, input.channel);
    });
  }
  async authenticate(request: FastifyRequest): Promise<Principal> {
    const bearer = request.headers.authorization;
    const cookie = request.cookies?.[this.cookieName()];
    const token = bearer?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? cookie;
    if (!token || (bearer && cookie)) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.', 401);
    const result = await this.db.query<{
      user_id: string;
      id: string;
      kind: 'guest' | 'registered';
      email: string | null;
      channel: 'web' | 'ios';
      csrf_hash: string;
    }>(
      `
      SELECT s.*,u.kind,u.email FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active'`,
      [hash(token)],
    );
    const row = result.rows[0];
    if (!row || (cookie && row.channel !== 'web') || (bearer && row.channel !== 'ios'))
      throw new ApiError('UNAUTHENTICATED', 'Session is invalid or expired.', 401);
    if (row.channel === 'web' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (
        !request.headers.origin ||
        !this.config.webOrigins.includes(request.headers.origin) ||
        typeof csrf !== 'string' ||
        !equalHash(csrf, row.csrf_hash)
      )
        throw new ApiError('CSRF_FAILED', 'Reload and try again.', 403);
    }
    return {
      userId: row.user_id,
      sessionId: row.id,
      kind: row.kind,
      email: row.email,
      channel: row.channel,
      csrfHash: row.csrf_hash,
    };
  }
  async refresh(raw: unknown) {
    const input = z
      .object({ refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(raw);
    const result = await this.db.transaction(async (tx) => {
      const selected = await tx.query<{
        session_id: string;
        user_id: string;
        used_at: Date | null;
        valid: boolean;
      }>(
        `
        SELECT r.*,s.user_id,(r.expires_at>now() AND s.created_at>now()-interval '30 days' AND s.revoked_at IS NULL AND u.status='active') AS valid
        FROM refresh_tokens r JOIN sessions s ON s.id=r.session_id JOIN users u ON u.id=s.user_id
        WHERE r.token_hash=$1 FOR UPDATE OF r,s`,
        [hash(input.refreshToken)],
      );
      const row = selected.rows[0];
      if (!row) return null;
      if (row.used_at) {
        await tx.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [row.session_id]);
        return null;
      }
      if (!row.valid) return null;
      await tx.query('UPDATE refresh_tokens SET used_at=now() WHERE token_hash=$1', [
        hash(input.refreshToken),
      ]);
      return this.issue(tx, row.user_id, 'ios', row.session_id);
    });
    if (!result) throw new ApiError('INVALID_REFRESH', 'Sign in again to continue.', 401);
    return result;
  }
  async logout(actor: Principal, all = false) {
    await this.db.query(`UPDATE sessions SET revoked_at=now() WHERE ${all ? 'user_id' : 'id'}=$1`, [
      all ? actor.userId : actor.sessionId,
    ]);
    return { data: { signedOut: true } };
  }
  async oidcStart(raw: unknown) {
    if (!this.jwks) throw new ApiError('NOT_CONFIGURED', 'Federated sign-in is not configured.', 503);
    const input = z.object({ challenge, channel }).strict().parse(raw);
    const id = randomUUID(),
      nonce = secret();
    await this.db.query(
      "INSERT INTO oidc_challenges(id,nonce,verifier_hash,channel,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
      [id, nonce, input.challenge, input.channel],
    );
    return { data: { challengeId: id, nonce } };
  }
  async oidcComplete(raw: unknown, linkTo?: Principal): Promise<Credentials> {
    if (!this.jwks) throw new ApiError('NOT_CONFIGURED', 'Federated sign-in is not configured.', 503);
    const input = z
      .object({ challengeId: z.string().uuid(), verifier, idToken: z.string().max(20_000) })
      .strict()
      .parse(raw);
    let claims;
    try {
      claims = (
        await jwtVerify(input.idToken, this.jwks, {
          issuer: this.config.OIDC_ISSUER,
          audience: this.config.OIDC_AUDIENCE,
          algorithms: ['RS256', 'ES256'],
          requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
          maxTokenAge: '10m',
        })
      ).payload;
    } catch {
      throw new ApiError('INVALID_CREDENTIAL', 'Identity token is invalid.', 401);
    }
    const email = z.string().email().max(254).safeParse(claims.email);
    const result = await this.db.transaction(async (tx) => {
      const state = await tx.query<{
        nonce: string;
        verifier_hash: string;
        channel: 'web' | 'ios';
        valid: boolean;
      }>(
        `SELECT *,(used_at IS NULL AND expires_at>now()) AS valid FROM oidc_challenges WHERE id=$1 FOR UPDATE`,
        [input.challengeId],
      );
      const row = state.rows[0];
      if (!row?.valid || row.nonce !== claims.nonce || row.verifier_hash !== challengeHash(input.verifier))
        return null;
      const linked = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM external_identities WHERE issuer=$1 AND subject=$2',
        [claims.iss, claims.sub],
      );
      let userId = linked.rows[0]?.user_id;
      if (linkTo && linkTo.kind !== 'registered')
        throw new ApiError('VERIFICATION_REQUIRED', 'Verify your account first.', 403);
      if (linkTo && userId && userId !== linkTo.userId)
        throw new ApiError('IDENTITY_ALREADY_LINKED', 'This identity belongs to another account.', 409);
      if (!userId) {
        if (linkTo) userId = linkTo.userId;
        else {
          if (!email.success || claims.email_verified !== true)
            throw new ApiError('VERIFICATION_REQUIRED', 'A verified provider email is required.', 403);
          const existing = await tx.query('SELECT id FROM users WHERE email=$1', [email.data.toLowerCase()]);
          if (existing.rowCount)
            throw new ApiError(
              'LINK_REQUIRED',
              'Sign in to your existing account before linking this identity.',
              409,
            );
          userId = randomUUID();
          await tx.query(
            "INSERT INTO users(id,email,email_verified_at,kind) VALUES($1,$2,now(),'registered')",
            [userId, email.data.toLowerCase()],
          );
        }
        await tx.query('INSERT INTO external_identities(issuer,subject,user_id) VALUES($1,$2,$3)', [
          claims.iss,
          claims.sub,
          userId,
        ]);
      }
      const user = await tx.query("SELECT id FROM users WHERE id=$1 AND status='active'", [userId]);
      if (!user.rowCount) return null;
      await tx.query('UPDATE oidc_challenges SET used_at=now() WHERE id=$1', [input.challengeId]);
      return this.issue(tx, userId, row.channel);
    });
    if (!result) throw new ApiError('INVALID_CREDENTIAL', 'Sign-in state is invalid or expired.', 401);
    return result;
  }
}
