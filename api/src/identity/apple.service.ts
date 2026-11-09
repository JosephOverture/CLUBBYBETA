import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { challengeHash, secret, hash, encrypt, decrypt } from '../platform/crypto';
import { audit } from '../organizations/organizations.service';
import { IdentityService, type Principal } from './identity.service';
import { AppleIdentityProvider, appleIssuer, type AppleProvider } from './apple-provider';
export class AppleService {
  readonly provider: AppleProvider;
  constructor(
    readonly db: Database,
    readonly identity: IdentityService,
    provider?: AppleProvider,
  ) {
    this.provider = provider ?? new AppleIdentityProvider(db.config);
  }
  enabled() {
    return this.db.config.APPLE_SIGN_IN_ENABLED === 'true';
  }
  async start(raw: unknown, actor?: Principal) {
    if (!this.enabled()) throw new ApiError('NOT_CONFIGURED', 'Sign in with Apple is not available.', 503);
    const input = z
      .object({ channel: z.enum(['web', 'ios']), challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(raw);
    if (actor && actor.kind !== 'registered')
      throw new ApiError('VERIFICATION_REQUIRED', 'Verify your account before linking Apple.', 403);
    const id = randomUUID(),
      state = secret(),
      nonce = secret();
    await this.db.query(
      "INSERT INTO apple_login_challenges(id,channel,verifier_hash,state_hash,nonce,link_user_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')",
      [id, input.channel, input.challenge, hash(state), nonce, actor?.userId ?? null],
    );
    return {
      data: {
        challengeId: id,
        state,
        nonce,
        clientId:
          input.channel === 'web'
            ? this.db.config.APPLE_SIGN_IN_WEB_CLIENT_ID
            : this.db.config.APPLE_SIGN_IN_IOS_CLIENT_ID,
        redirectURI: input.channel === 'web' ? this.db.config.APPLE_SIGN_IN_REDIRECT_URI : null,
      },
    };
  }
  async complete(raw: unknown, actor?: Principal) {
    if (!this.enabled()) throw new ApiError('NOT_CONFIGURED', 'Sign in with Apple is not available.', 503);
    const input = z
      .object({
        challengeId: z.string().uuid(),
        verifier: z.string().regex(/^[A-Za-z0-9_~-]{43,128}$/),
        state: z.string().min(40).max(100),
        code: z.string().min(1).max(10000),
      })
      .strict()
      .parse(raw);
    const state = await this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          'SELECT *,(used_at IS NULL AND expires_at>clock_timestamp()) AS valid FROM apple_login_challenges WHERE id=$1 FOR UPDATE',
          [input.challengeId],
        )
      ).rows[0];
      if (
        !row ||
        !row.valid ||
        row.verifier_hash !== challengeHash(input.verifier) ||
        row.state_hash !== hash(input.state) ||
        (row.link_user_id ?? null) !== (actor?.userId ?? null)
      )
        throw new ApiError('INVALID_CREDENTIAL', 'Apple sign-in state is invalid or expired.', 401);
      // Claim once before exchanging a single-use provider code; no database lock spans external work.
      await tx.query('UPDATE apple_login_challenges SET used_at=now() WHERE id=$1', [input.challengeId]);
      return row;
    });
    const apple = await this.provider.authenticate(input.code, state.channel, state.nonce);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,84))', [apple.subject]);
      const authenticatedAt = new Date((apple.authenticatedAt ?? Math.floor(Date.now() / 1000)) * 1000);
      const revoked = (
        await tx.query('SELECT 1 FROM apple_revocations WHERE subject_hash=$1 AND revoked_at>=$2', [
          hash(apple.subject),
          authenticatedAt,
        ])
      ).rowCount;
      if (revoked)
        throw new ApiError(
          'INVALID_CREDENTIAL',
          'Apple credentials were revoked. Start a fresh sign-in.',
          401,
        );
      const linked = (
        await tx.query('SELECT user_id FROM external_identities WHERE issuer=$1 AND subject=$2', [
          appleIssuer,
          apple.subject,
        ])
      ).rows[0];
      if (actor && linked && linked.user_id !== actor.userId)
        throw new ApiError(
          'IDENTITY_ALREADY_LINKED',
          'This Apple identity belongs to another Clubby account.',
          409,
        );
      let userId: string = linked?.user_id ?? actor?.userId;
      if (!userId) {
        if (!apple.email || !apple.verified)
          throw new ApiError(
            'VERIFICATION_REQUIRED',
            'A verified Apple email is required for a new account.',
            403,
          );
        if ((await tx.query('SELECT id FROM users WHERE email=$1', [apple.email])).rowCount)
          throw new ApiError(
            'LINK_REQUIRED',
            'Sign in to your existing Clubby account, then link Apple in account settings.',
            409,
          );
        userId = randomUUID();
        await tx.query(
          "INSERT INTO users(id,email,email_verified_at,kind) VALUES($1,$2,now(),'registered')",
          [userId, apple.email],
        );
      }
      const user = (
        await tx.query(
          "SELECT id FROM users WHERE id=$1 AND kind='registered' AND status='active' FOR SHARE",
          [userId],
        )
      ).rows[0];
      if (!user) throw new ApiError('INVALID_CREDENTIAL', 'This Clubby account is unavailable.', 401);
      const previous = (
        await tx.query('SELECT subject FROM external_identities WHERE user_id=$1 AND issuer=$2', [
          userId,
          appleIssuer,
        ])
      ).rows[0];
      if (previous && previous.subject !== apple.subject)
        throw new ApiError(
          'IDENTITY_ALREADY_LINKED',
          'This Clubby account already has a different Apple identity.',
          409,
        );
      if (!linked)
        await tx.query('INSERT INTO external_identities(issuer,subject,user_id) VALUES($1,$2,$3)', [
          appleIssuer,
          apple.subject,
          userId,
        ]);
      const clientId =
        state.channel === 'web'
          ? this.db.config.APPLE_SIGN_IN_WEB_CLIENT_ID!
          : this.db.config.APPLE_SIGN_IN_IOS_CLIENT_ID!;
      await tx.query(
        "INSERT INTO apple_identity_grants(user_id,client_id,subject,refresh_encrypted,authenticated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,client_id) DO UPDATE SET subject=EXCLUDED.subject,refresh_encrypted=EXCLUDED.refresh_encrypted,authenticated_at=EXCLUDED.authenticated_at,state='active',version=apple_identity_grants.version+1,updated_at=now()",
        [
          userId,
          clientId,
          apple.subject,
          encrypt(apple.refreshToken, this.db.config.encryptionKeys),
          authenticatedAt,
        ],
      );
      await audit(
        tx,
        userId,
        actor ? 'identity.apple-link' : 'identity.apple-signin',
        'user',
        userId,
        actor ? 'User explicitly linked Apple identity' : 'Verified Apple authentication',
      );
      return this.identity.issue(tx, userId, state.channel);
    });
  }
  async revokeUser(userId: string) {
    // Deletion first disables the user so no concurrent successful sign-in can replace these grants.
    const user = (await this.db.query('SELECT status FROM users WHERE id=$1', [userId])).rows[0];
    if (!user || !['deletion-pending', 'deleted'].includes(user.status))
      throw new Error('Disable the account before revoking deletion credentials.');
    const rows = (
      await this.db.query(
        "UPDATE apple_identity_grants SET state='revoking' WHERE user_id=$1 AND state<>'revoked' RETURNING *",
        [userId],
      )
    ).rows;
    for (const row of rows) {
      await this.provider.revoke(
        row.client_id,
        decrypt(row.refresh_encrypted, this.db.config.encryptionKeys) as string,
      );
      await this.db.query(
        "UPDATE apple_identity_grants SET state='revoked',refresh_encrypted=NULL,updated_at=now() WHERE user_id=$1 AND client_id=$2 AND version=$3",
        [userId, row.client_id, row.version],
      );
    }
  }
  async maintenance() {
    await this.db.query("DELETE FROM apple_login_challenges WHERE expires_at<now()-interval '1 day'");
  }
}
