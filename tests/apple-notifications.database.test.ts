import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { commerceFixture } from './commerce-fixture';
import { AppleService } from '../apps/api/src/identity/apple.service';
import { AppleNotificationsService } from '../apps/api/src/identity/apple-notifications.service';
import { type AppleIdentity, type AppleProvider, appleIssuer } from '../apps/api/src/identity/apple-provider';
import { PrivacyService } from '../apps/api/src/privacy/privacy.service';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { hash, encrypt, challengeHash } from '../apps/api/src/platform/crypto';
const settings = {
  APPLE_SIGN_IN_ENABLED: 'true',
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_SIGN_IN_KEY_ID: 'KEY1234567',
  APPLE_SIGN_IN_KEY_PATH: 'not-read-fixture.p8',
  APPLE_SIGN_IN_WEB_CLIENT_ID: 'com.clubby.web',
  APPLE_SIGN_IN_IOS_CLIENT_ID: 'com.clubby.app',
  APPLE_SIGN_IN_REDIRECT_URI: 'https://clubby.example.test/',
  WEB_ORIGINS: 'http://localhost:8081,https://clubby.example.test',
};
describe.skipIf(!process.env.TEST_DATABASE_URL)('signed Apple account notifications', () => {
  let f: Awaited<ReturnType<typeof commerceFixture>>,
    keys: Awaited<ReturnType<typeof generateKeyPair>>,
    identity: AppleIdentity,
    apple: AppleService,
    notifications: AppleNotificationsService;
  let revoked = 0;
  const provider: AppleProvider = {
    authenticate: async () => identity,
    revoke: async () => {
      revoked++;
    },
  };
  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
    f = await commerceFixture(
      settings,
      undefined,
      provider,
      createLocalJWKSet({
        keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'notification-key', alg: 'RS256' }],
      }),
    );
    apple = f.app.get(AppleService);
    notifications = f.app.get(AppleNotificationsService);
  });
  afterAll(async () => {
    if (f) await f.close();
  });
  async function login() {
    const verifier = 'v'.repeat(64),
      start = await apple.start({ channel: 'ios', challenge: challengeHash(verifier) });
    return apple.complete({
      challengeId: start.data.challengeId,
      verifier,
      state: start.data.state,
      code: 'verified-provider-code',
    });
  }
  async function account() {
    identity = {
      subject: randomUUID(),
      email: `${randomUUID()}@privaterelay.appleid.com`,
      verified: true,
      refreshToken: 'provider-refresh',
      authenticatedAt: Math.floor(Date.now() / 1000) - 120,
    };
    const credentials = await login();
    const user = (
      await f.db.query('SELECT user_id FROM external_identities WHERE issuer=$1 AND subject=$2', [
        appleIssuer,
        identity.subject,
      ])
    ).rows[0]!;
    return { ...identity, userId: user.user_id as string, credentials };
  }
  async function signed(
    event: unknown,
    options: {
      id?: string;
      audience?: string;
      issuer?: string;
      age?: number;
      stringify?: boolean;
      otherKey?: boolean;
    } = {},
  ) {
    const key = options.otherKey ? (await generateKeyPair('RS256')).privateKey : keys.privateKey;
    return new SignJWT({ events: options.stringify ? JSON.stringify(event) : event })
      .setProtectedHeader({ alg: 'RS256', kid: 'notification-key' })
      .setIssuer(options.issuer ?? appleIssuer)
      .setAudience(options.audience ?? 'com.clubby.app')
      .setJti(options.id ?? randomUUID())
      .setIssuedAt(Math.floor(Date.now() / 1000) - (options.age ?? 0))
      .sign(key);
  }
  const time = () => Math.floor(Date.now() / 1000) - 30;
  async function send(payload: string) {
    return f.app.inject({ method: 'POST', url: '/v1/auth/apple/notifications', payload: { payload } });
  }
  it('accepts the official no-expiry signed format and idempotently starts erasure without exposing tokens', async () => {
    const user = await account(),
      id = randomUUID(),
      event = { type: 'consent-revoked', sub: user.subject, event_time: time() },
      token = await signed(event, { id });
    const response = await send(token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { accepted: true } });
    expect((await send(token)).statusCode).toBe(200);
    expect((await f.db.query('SELECT status FROM users WHERE id=$1', [user.userId])).rows[0]?.status).toBe(
      'deletion-pending',
    );
    expect(
      (
        await f.app.inject({
          url: '/v1/auth/session',
          headers: { authorization: `Bearer ${user.credentials.token}` },
        })
      ).statusCode,
    ).toBe(401);
    const requests = (
      await f.db.query("SELECT id,status FROM privacy_requests WHERE user_id=$1 AND kind='delete'", [
        user.userId,
      ])
    ).rows;
    expect(requests).toHaveLength(1);
    const previous = revoked;
    await f.app.get(PrivacyService).erase(requests[0]!.id);
    expect(revoked).toBe(previous);
    expect((await f.db.query('SELECT status FROM users WHERE id=$1', [user.userId])).rows[0]?.status).toBe(
      'deleted',
    );
    expect(
      (await f.db.query('SELECT * FROM apple_notification_inbox WHERE id=$1', [id])).rows[0],
    ).toMatchObject({ subject_hash: hash(user.subject) });
    expect((await send(await signed({ ...event, type: 'account-deleted' }, { id }))).statusCode).toBe(409);
  });
  it('rejects wrong signatures, issuer, audience, stale JWTs, malformed event claims and future event times', async () => {
    const user = await account(),
      event = { type: 'account-deleted', sub: user.subject, event_time: time() };
    for (const options of [
      { audience: 'another.app' },
      { issuer: 'https://attacker.example' },
      { age: 8 * 86400 },
      { otherKey: true },
    ])
      expect((await send(await signed(event, options))).statusCode).toBe(401);
    expect((await send(await signed({ ...event, event_time: Date.now() + 120000 }))).statusCode).toBe(401);
    expect((await send(await signed({ type: 'account-deleted', sub: user.subject }))).statusCode).toBe(401);
    expect((await f.db.query('SELECT status FROM users WHERE id=$1', [user.userId])).rows[0]?.status).toBe(
      'active',
    );
  });
  it('immediately disables an account when Apple deletion arrives before its pending deletion job', async () => {
    const user = await account();
    const requested = await f.app.inject({
      method: 'POST',
      url: '/v1/privacy/requests',
      headers: { authorization: `Bearer ${user.credentials.token}` },
      payload: { kind: 'delete', confirmConsequences: true },
    });
    expect(requested.statusCode).toBe(201);
    expect(
      (await send(await signed({ type: 'account-deleted', sub: user.subject, event_time: time() })))
        .statusCode,
    ).toBe(200);
    const requests = (
      await f.db.query("SELECT id,status FROM privacy_requests WHERE user_id=$1 AND kind='delete'", [
        user.userId,
      ])
    ).rows;
    expect(requests).toEqual([{ id: requested.json().data.id, status: 'processing' }]);
    expect(
      (
        await f.app.inject({
          url: '/v1/auth/session',
          headers: { authorization: `Bearer ${user.credentials.token}` },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('handles ordered relay toggles without turning marketing consent on or overriding bounce suppression', async () => {
    const user = await account(),
      base = time() - 20,
      event = {
        type: 'email-disabled',
        sub: user.subject,
        email: user.email,
        is_private_email: 'true',
        event_time: base,
      };
    await notifications.receive({ payload: await signed(event, { stringify: true }) });
    const delivery = randomUUID();
    await f.db.query(
      "INSERT INTO notification_deliveries(id,user_id,kind,recipient_hash,encrypted_payload) VALUES($1,$2,'booking-confirmed',$3,$4)",
      [
        delivery,
        user.userId,
        hash(user.email!),
        encrypt({ to: user.email, subject: 'Booking', text: 'Confirmed' }, f.db.config.APP_ENCRYPTION_KEY),
      ],
    );
    const mail = f.app.get(NotificationsService);
    expect(await mail.mayEmail(delivery)).toBe(false);
    await notifications.receive({
      payload: await signed({ ...event, type: 'email-enabled', event_time: base - 1 }),
    });
    expect(await mail.mayEmail(delivery)).toBe(false);
    await notifications.receive({
      payload: await signed({ ...event, type: 'email-enabled', event_time: (base + 10) * 1000 }),
    });
    expect(await mail.mayEmail(delivery)).toBe(true);
    const person = await f.actor();
    await expect(
      f.db.query(
        'INSERT INTO apple_email_preferences(user_id,recipient_hash,disabled,changed_at) VALUES($1,$2,true,now())',
        [person.principal.userId, hash(person.email)],
      ),
    ).resolves.toBeDefined();
    await notifications.receive({
      payload: await signed({ ...event, email: person.email, event_time: base + 20 }),
    });
    expect(
      (await f.db.query('SELECT disabled FROM apple_email_preferences WHERE user_id=$1', [user.userId]))
        .rows[0]?.disabled,
    ).toBe(false);
    expect(
      (await f.db.query('SELECT marketing_email FROM user_preferences WHERE user_id=$1', [user.userId])).rows,
    ).toHaveLength(0);
    const feedback = randomUUID();
    await f.db.query(
      "INSERT INTO email_feedback(id,provider_reference,event_type,occurred_at,payload_hash) VALUES($1,'email-fixture','email.bounced',now(),'fixture')",
      [feedback],
    );
    await f.db.query(
      "INSERT INTO email_suppressions(recipient_hash,reason,feedback_id) VALUES($1,'bounced',$2)",
      [hash(user.email!), feedback],
    );
    expect(await mail.mayEmail(delivery)).toBe(false);
  });
  it('does not let delayed revocation erase a more recently authorized identity and rejects old credentials after an unknown-subject revocation', async () => {
    const user = await account();
    identity = { ...user, authenticatedAt: Math.floor(Date.now() / 1000) };
    await login();
    await notifications.receive({
      payload: await signed({ type: 'consent-revoked', sub: user.subject, event_time: time() }),
    });
    expect((await f.db.query('SELECT status FROM users WHERE id=$1', [user.userId])).rows[0]?.status).toBe(
      'active',
    );
    identity = {
      subject: randomUUID(),
      email: `${randomUUID()}@privaterelay.appleid.com`,
      verified: true,
      refreshToken: 'new-refresh',
      authenticatedAt: time() - 10,
    };
    await notifications.receive({
      payload: await signed({ type: 'account-delete', sub: identity.subject, event_time: time() }),
    });
    await expect(login()).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    identity.authenticatedAt = Math.floor(Date.now() / 1000);
    await expect(login()).resolves.toBeDefined();
  });
});
