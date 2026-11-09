import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { commerceFixture } from './commerce-fixture';
import { AppleService } from '../apps/api/src/identity/apple.service';
import { type AppleProvider, type AppleIdentity, appleIssuer } from '../apps/api/src/identity/apple-provider';
import { challengeHash, decrypt } from '../apps/api/src/platform/crypto';
const settings = {
  APPLE_SIGN_IN_ENABLED: 'true',
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_SIGN_IN_KEY_ID: 'KEY1234567',
  APPLE_SIGN_IN_KEY_PATH: 'fixture-key-not-used.p8',
  APPLE_SIGN_IN_WEB_CLIENT_ID: 'com.clubby.web',
  APPLE_SIGN_IN_IOS_CLIENT_ID: 'com.clubby.app',
  APPLE_SIGN_IN_REDIRECT_URI: 'https://clubby.example.test/',
  WEB_ORIGINS: 'http://localhost:8081,https://clubby.example.test',
};
describe.skipIf(!process.env.TEST_DATABASE_URL)('Apple identity account and deletion boundaries', () => {
  let f: Awaited<ReturnType<typeof commerceFixture>>, apple: AppleService;
  let identity: AppleIdentity,
    calls = 0,
    failRevocation = false;
  const revoked: string[] = [];
  const provider: AppleProvider = {
    authenticate: async () => {
      calls++;
      return identity;
    },
    revoke: async (client, token) => {
      if (failRevocation) throw new Error('Temporary provider failure');
      revoked.push(`${client}:${token}`);
    },
  };
  beforeAll(async () => {
    f = await commerceFixture(settings, undefined, provider);
    apple = f.app.get(AppleService);
  });
  afterAll(async () => {
    if (f) await f.close();
  });
  async function start(channel: 'web' | 'ios' = 'ios', actor?: typeof f.owner.principal) {
    const verifier = 'v'.repeat(64),
      value = await apple.start({ channel, challenge: challengeHash(verifier) }, actor);
    return { ...value.data, verifier, code: 'single-use-provider-code' };
  }
  const body = (v: Awaited<ReturnType<typeof start>>) => ({
    challengeId: v.challengeId,
    verifier: v.verifier,
    code: v.code,
    state: v.state,
  });
  function account(email = `${randomUUID()}@privaterelay.appleid.com`) {
    return { subject: randomUUID(), email, verified: true, refreshToken: `refresh-${randomUUID()}` };
  }
  it('claims challenges once, creates verified identities and stores only encrypted provider refresh tokens', async () => {
    identity = account();
    const pending = await start(),
      before = calls;
    await expect(apple.complete({ ...body(pending), state: 'x'.repeat(43) })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
    });
    expect(calls).toBe(before);
    const result = await apple.complete(body(pending));
    expect(result.channel).toBe('ios');
    await expect(apple.complete(body(pending))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    expect(calls).toBe(before + 1);
    const grant = (await f.db.query('SELECT * FROM apple_identity_grants WHERE user_id=$1', [result.userId]))
      .rows[0]!;
    expect(grant.refresh_encrypted).not.toContain(identity.refreshToken);
    expect(decrypt(grant.refresh_encrypted, f.db.config.APP_ENCRYPTION_KEY)).toBe(identity.refreshToken);
    const next = await start('web');
    identity = { ...identity, email: undefined, verified: false };
    expect((await apple.complete(body(next))).userId).toBe(result.userId);
    expect(
      (
        await f.db.query('SELECT count(*)::int AS count FROM apple_identity_grants WHERE user_id=$1', [
          result.userId,
        ])
      ).rows[0]!.count,
    ).toBe(2);
  });
  it('requires explicit linking for matching emails and rejects replacing another Apple identity', async () => {
    const user = await f.actor();
    identity = account(user.email);
    const pending = await start();
    await expect(apple.complete(body(pending))).rejects.toMatchObject({ code: 'LINK_REQUIRED' });
    const linking = await start('ios', user.principal);
    await expect(apple.complete(body(linking))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    expect((await apple.complete(body(linking), user.principal)).userId).toBe(user.principal.userId);
    const other = await f.actor(),
      wrong = await start('ios', other.principal);
    await expect(apple.complete(body(wrong), other.principal)).rejects.toMatchObject({
      code: 'IDENTITY_ALREADY_LINKED',
    });
    identity = account();
    const replace = await start('ios', user.principal);
    await expect(apple.complete(body(replace), user.principal)).rejects.toMatchObject({
      code: 'IDENTITY_ALREADY_LINKED',
    });
    expect(
      (
        await f.db.query(
          'SELECT count(*)::int AS count FROM external_identities WHERE user_id=$1 AND issuer=$2',
          [user.principal.userId, appleIssuer],
        )
      ).rows[0]!.count,
    ).toBe(1);
  });
  it('requires verified provider email for first registration and invalidates expired or concurrent challenges', async () => {
    identity = { ...account(), verified: false };
    await expect(apple.complete(body(await start()))).rejects.toMatchObject({
      code: 'VERIFICATION_REQUIRED',
    });
    identity = account();
    const expired = await start();
    await f.db.query('UPDATE apple_login_challenges SET expires_at=now() WHERE id=$1', [expired.challengeId]);
    await expect(apple.complete(body(expired))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    const pending = await start(),
      attempts = await Promise.allSettled([apple.complete(body(pending)), apple.complete(body(pending))]);
    expect(attempts.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
  });
  it('issues HttpOnly web cookies without exposing provider or bearer credentials', async () => {
    identity = account();
    const pending = await start('web'),
      reply = await f.app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/v1/auth/apple/complete',
          payload: body(pending),
          headers: { origin: 'https://clubby.example.test' },
        });
    expect(reply.statusCode).toBe(201);
    expect(reply.headers['set-cookie']).toContain('HttpOnly');
    expect(reply.json().data.token).toBeUndefined();
    expect(reply.body).not.toContain(identity.refreshToken);
  });
  it('retains failed revocations for retry, erases completed tokens and rejects deleted account sign-in', async () => {
    identity = account();
    const result = await apple.complete(body(await start()));
    await expect(apple.revokeUser(result.userId)).rejects.toThrow('Disable the account');
    await f.db.query("UPDATE users SET status='deletion-pending' WHERE id=$1", [result.userId]);
    failRevocation = true;
    await expect(apple.revokeUser(result.userId)).rejects.toThrow('Temporary provider failure');
    expect(
      (
        await f.db.query('SELECT state,refresh_encrypted FROM apple_identity_grants WHERE user_id=$1', [
          result.userId,
        ])
      ).rows[0]!.state,
    ).toBe('revoking');
    failRevocation = false;
    await apple.revokeUser(result.userId);
    await apple.revokeUser(result.userId);
    expect(
      (
        await f.db.query('SELECT state,refresh_encrypted FROM apple_identity_grants WHERE user_id=$1', [
          result.userId,
        ])
      ).rows[0],
    ).toEqual({ state: 'revoked', refresh_encrypted: null });
    expect(revoked.filter((v) => v.endsWith(identity.refreshToken))).toHaveLength(1);
    await expect(apple.complete(body(await start()))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
  });
});
