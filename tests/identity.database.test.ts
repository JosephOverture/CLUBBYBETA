import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { Database } from '../apps/api/src/platform/database';
import { migrate } from '../apps/api/src/platform/migrations';
import { secret, challengeHash, decrypt, hash, encrypt } from '../apps/api/src/platform/crypto';
import { JobQueue, platformHandlers, enqueue } from '../apps/api/src/platform/jobs';
import { createApplication } from '../apps/api/src/bootstrap';
import { IdentityService, type Principal, type Credentials } from '../apps/api/src/identity/identity.service';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
import { NotificationDelivery } from '../apps/api/src/notifications/delivery';
import { PrivacyService } from '../apps/api/src/privacy/privacy.service';
import { isolatedDatabase } from './database-helper';

describe.skipIf(!process.env.TEST_DATABASE_URL)('identity and business access on PostgreSQL', () => {
  let db: Database,
    dispose: () => Promise<void>,
    app: NestFastifyApplication,
    identity: IdentityService,
    organizations: OrganizationsService,
    privacy: PrivacyService;
  const encryptionKey = 'a9'.repeat(32);
  const credentials = new Map<string, Credentials>();
  async function begin(email: string, clientChannel: 'web' | 'ios' = 'ios') {
    const verifier = secret();
    const start = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/start',
      payload: { email, channel: clientChannel, challenge: challengeHash(verifier) },
    });
    expect(start.statusCode).toBe(202);
    const deliveries = await db.query<{ encrypted_payload: string }>(
      'SELECT encrypted_payload FROM notification_deliveries WHERE recipient_hash=$1 ORDER BY created_at DESC LIMIT 1',
      [hash(email.toLowerCase())],
    );
    const message = decrypt(deliveries.rows[0]!.encrypted_payload, encryptionKey) as { text: string };
    const token = message.text.match(/\n\n([A-Za-z0-9_-]{43})\n\n/)![1]!;
    return { challengeId: start.json().data.challengeId, token, verifier };
  }
  async function login(email: string) {
    const result = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/complete',
      payload: await begin(email),
    });
    expect(result.statusCode).toBe(201);
    const value = result.json().data as Credentials;
    credentials.set(email, value);
    const actor = await identity.authenticate({
      method: 'GET',
      headers: { authorization: `Bearer ${value.token}` },
      cookies: {},
    } as FastifyRequest);
    return actor;
  }
  const auth = (email: string) => ({ authorization: `Bearer ${credentials.get(email)!.token}` });
  let owner: Principal, admin: Principal, outsider: Principal, organizationId: string;
  beforeAll(async () => {
    ({ db, dispose } = await isolatedDatabase({ APP_ENCRYPTION_KEY: encryptionKey, EMAIL_MODE: 'file' }));
    await migrate(db, resolve('database/migrations'));
    app = await createApplication(db.config, db);
    identity = app.get(IdentityService);
    organizations = app.get(OrganizationsService);
    privacy = app.get(PrivacyService);
    owner = await login('owner@example.test');
    admin = await login('admin@example.test');
    outsider = await login('outsider@example.test');
    await db.query("INSERT INTO platform_grants(user_id,role) VALUES($1,'admin')", [admin.userId]);
  });
  afterAll(async () => {
    if (app) await app.close();
    else if (db) await db.onApplicationShutdown();
    if (dispose) await dispose();
  });

  it('does not accept a client-supplied identity or role', async () => {
    expect(
      (
        await app.inject({
          url: '/v1/organizations',
          headers: { 'x-user-id': owner.userId, 'x-role': 'admin' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: '/v1/admin/audit', headers: auth('outsider@example.test') })).statusCode,
    ).toBe(403);
    const guest = await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { channel: 'ios' } });
    expect(
      (
        await app.inject({
          url: '/v1/organizations',
          headers: { authorization: `Bearer ${guest.json().data.token}` },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('binds sign-in to PKCE and consumes an email code only once under a race', async () => {
    const input = await begin('single-use@example.test');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/email/complete',
          payload: { ...input, verifier: secret() },
        })
      ).statusCode,
    ).toBe(401);
    const results = await Promise.all(
      [0, 1].map(() => app.inject({ method: 'POST', url: '/v1/auth/email/complete', payload: input })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 401]);
    const expired = await begin('expired@example.test');
    await db.query("UPDATE login_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [
      expired.challengeId,
    ]);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/auth/email/complete', payload: expired })).statusCode,
    ).toBe(401);
  });
  it('web and native email sign-in resolve to one customer and enforce cookie CSRF', async () => {
    const web = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/complete',
      payload: await begin('owner@example.test', 'web'),
    });
    expect(web.json().data.userId).toBe(owner.userId);
    expect(web.json().data.token).toBeUndefined();
    const cookie = String(web.headers['set-cookie']).split(';')[0]!;
    expect(web.headers['set-cookie']).toContain('HttpOnly');
    expect(web.headers['set-cookie']).toContain('SameSite=Lax');
    const profile = { displayName: 'Clubby Owner' };
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/auth/profile',
      headers: { cookie },
      payload: profile,
    });
    expect(missing.statusCode).toBe(403);
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/auth/profile',
      headers: { cookie, origin: 'https://attacker.example', 'x-csrf-token': web.json().data.csrfToken },
      payload: profile,
    });
    expect(denied.statusCode).toBe(403);
    const success = await app.inject({
      method: 'POST',
      url: '/v1/auth/profile',
      headers: { cookie, origin: 'http://localhost:8081', 'x-csrf-token': web.json().data.csrfToken },
      payload: profile,
    });
    expect(success.statusCode).toBe(201);
    expect(
      (await app.inject({ url: '/v1/auth/session', headers: auth('owner@example.test') })).json().data
        .displayName,
    ).toBe('Clubby Owner');
  });
  it('refresh replay revokes the session family, including the newly issued access token', async () => {
    await login('refresh@example.test');
    const old = credentials.get('refresh@example.test')!;
    const fresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: old.refreshToken },
    });
    expect(fresh.statusCode).toBe(201);
    expect(
      (await app.inject({ url: '/v1/auth/session', headers: { authorization: `Bearer ${old.token}` } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/refresh',
          payload: { refreshToken: old.refreshToken },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: '/v1/auth/session',
          headers: { authorization: `Bearer ${fresh.json().data.token}` },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('persists sessions across application/service instances and immediately enforces suspension', async () => {
    const other = new IdentityService(db, db.config);
    expect(
      (
        await other.authenticate({
          method: 'GET',
          headers: auth('owner@example.test'),
          cookies: {},
        } as FastifyRequest)
      ).userId,
    ).toBe(owner.userId);
    const actor = await login('suspended@example.test');
    await db.query("UPDATE users SET status='suspended' WHERE id=$1", [actor.userId]);
    expect(
      (await app.inject({ url: '/v1/auth/session', headers: auth('suspended@example.test') })).statusCode,
    ).toBe(401);
  });
  it('keeps pending organizations ineligible and audits reviewed version changes', async () => {
    const applied = await organizations.apply(owner, {
      name: 'Test Organization',
      legalName: 'Test Organization SRL',
      countryCode: 'IT',
    });
    organizationId = applied.data.id;
    await expect(organizations.authorize(owner, organizationId, 'venue.edit')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      organizations.review(outsider, organizationId, {
        status: 'approved',
        expectedVersion: 1,
        reason: 'Reviewed business',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await organizations.review(admin, organizationId, {
      status: 'approved',
      expectedVersion: 1,
      reason: 'Reviewed business',
    });
    await expect(
      organizations.review(admin, organizationId, {
        status: 'approved',
        expectedVersion: 1,
        reason: 'Reviewed business',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await organizations.authorize(owner, organizationId, 'venue.edit');
    expect((await organizations.list(outsider)).data).toHaveLength(0);
    await expect(db.query("UPDATE audit_events SET reason='rewrite'")).rejects.toThrow('append-only');
  });
  it('binds invitations to verified email and venue scope, and revokes access without issuing a new token', async () => {
    const door = await login('door@example.test');
    await db.query(
      "INSERT INTO destinations(id,name,country_code,timezone,currency) VALUES('milan','Milan','IT','Europe/Rome','EUR')",
    );
    await db.query(
      "INSERT INTO venues(id,destination_id,name,organization_id) VALUES('venue-a','milan','A',$1),('venue-b','milan','B',$1)",
      [organizationId],
    );
    await expect(
      organizations.invite(owner, organizationId, {
        email: door.email,
        role: 'door',
        venueIds: ['foreign-venue'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    await organizations.invite(owner, organizationId, {
      email: door.email,
      role: 'door',
      venueIds: ['venue-a'],
    });
    const mail = await db.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM notification_deliveries WHERE kind='staff-invitation' ORDER BY created_at DESC LIMIT 1",
    );
    const token = (decrypt(mail.rows[0]!.encrypted_payload, encryptionKey) as { text: string }).text.match(
      /code ([A-Za-z0-9_-]{43})/,
    )![1]!;
    await expect(organizations.accept(outsider, { token })).rejects.toMatchObject({
      code: 'INVALID_INVITATION',
    });
    await organizations.accept(door, { token });
    await organizations.authorizeVenue(door, 'venue-a', 'admissions.redeem');
    await expect(organizations.authorizeVenue(door, 'venue-b', 'admissions.redeem')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(organizations.authorizeVenue(door, 'venue-a', 'venue.edit')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const membership = await db.query<{ id: string }>('SELECT id FROM memberships WHERE user_id=$1', [
      door.userId,
    ]);
    await organizations.revoke(owner, organizationId, membership.rows[0]!.id, 'Staff access ended');
    await expect(organizations.authorizeVenue(door, 'venue-a', 'admissions.redeem')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(organizations.accept(door, { token })).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
  });
  it('writes one development email and marks the durable delivery sent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clubby-mail-test-'));
    try {
      const delivery = new NotificationDelivery(db, db.config, fetch, directory);
      const selected = await db.query<{ id: string }>(
        'SELECT id FROM notification_deliveries ORDER BY created_at LIMIT 1',
      );
      const id = selected.rows[0]!.id;
      await delivery.send({ deliveryId: id }, id);
      await delivery.send({ deliveryId: id }, id);
      expect(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')).subject).toBe(
        'Your Clubby sign-in code',
      );
      expect(
        (await db.query('SELECT status FROM notification_deliveries WHERE id=$1', [id])).rows[0]?.status,
      ).toBe('sent');
    } finally {
      const checked = resolve(directory);
      if (!checked.startsWith(resolve(tmpdir(), 'clubby-mail-test-'))) throw new Error('Unsafe test cleanup');
      await rm(checked, { recursive: true, force: true });
    }
  });
  it('sends provider email outside transaction with a stable idempotency key', async () => {
    const id = randomUUID(),
      jobId = randomUUID();
    await db.query("INSERT INTO notification_deliveries(id,kind,encrypted_payload) VALUES($1,'test',$2)", [
      id,
      encrypt({ to: 'test@example.test', subject: 'Test', text: 'Test' }, encryptionKey),
    ]);
    let calls = 0;
    const transport: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://api.resend.com/emails');
      expect(new Headers(init?.headers).get('idempotency-key')).toBe(jobId);
      calls++;
      return new Response(JSON.stringify({ id: 'provider-reference' }), { status: 200 });
    };
    const delivery = new NotificationDelivery(
      db,
      {
        ...db.config,
        EMAIL_MODE: 'resend',
        EMAIL_FROM: 'clubby@example.test',
        RESEND_API_KEY: 'test-secret-key',
      },
      transport,
    );
    await delivery.send({ deliveryId: id }, jobId);
    await delivery.send({ deliveryId: id }, jobId);
    expect(calls).toBe(1);
  });
  it('exports only the requesting account and deletes personal data without leaving valid sessions', async () => {
    const person = await login('privacy@example.test');
    const exported = await privacy.request(person, { kind: 'export' });
    await db.transaction((tx) => privacy.handler(tx, { requestId: exported.data.id }, exported.data.id));
    const result = (await privacy.export(person, exported.data.id)) as {
      data: { profile: { email: string }; memberships: unknown[] };
    };
    expect(result.data.profile.email).toBe('privacy@example.test');
    expect(result.data.memberships).toHaveLength(0);
    await expect(privacy.export(outsider, exported.data.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const deletion = await privacy.request(person, { kind: 'delete', confirmConsequences: true });
    await db.transaction((tx) => privacy.handler(tx, { requestId: deletion.data.id }, deletion.data.id));
    await privacy.erase(deletion.data.id);
    expect((await db.query('SELECT email,status FROM users WHERE id=$1', [person.userId])).rows[0]).toEqual({
      email: null,
      status: 'deleted',
    });
    expect(
      (await app.inject({ url: '/v1/auth/session', headers: auth('privacy@example.test') })).statusCode,
    ).toBe(401);
    expect(
      (await db.query('SELECT result_encrypted FROM privacy_requests WHERE id=$1', [exported.data.id]))
        .rows[0]?.result_encrypted,
    ).toBeNull();
  });
  it('pauses ownerless seller sales and revokes access before asynchronous erasure', async () => {
    const deletion = await privacy.request(owner, { kind: 'delete', confirmConsequences: true });
    await db.transaction((tx) => privacy.handler(tx, { requestId: deletion.data.id }, deletion.data.id));
    expect((await privacy.status(owner, deletion.data.id)).data.status).toBe('processing');
    expect(
      (await db.query('SELECT privacy_sales_paused FROM organizations WHERE id=$1', [organizationId]))
        .rows[0]!.privacy_sales_paused,
    ).toBe(true);
  });
  it('verifies OIDC issuer/audience/nonce/signature and refuses automatic email linking', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const service = new IdentityService(
      db,
      { ...db.config, OIDC_ISSUER: 'https://identity.example', OIDC_AUDIENCE: 'clubby' },
      createLocalJWKSet({ keys: [await exportJWK(publicKey)] }),
    );
    const verifier = secret();
    const started = await service.oidcStart({ channel: 'ios', challenge: challengeHash(verifier) });
    const sign = (email: string, nonce = started.data.nonce, audience = 'clubby') =>
      new SignJWT({ email, email_verified: true, nonce })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer('https://identity.example')
        .setAudience(audience)
        .setSubject('provider-subject')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    await expect(
      service.oidcComplete({
        challengeId: started.data.challengeId,
        verifier,
        idToken: await sign('oidc@example.test', 'wrong-nonce'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    await expect(
      service.oidcComplete({
        challengeId: started.data.challengeId,
        verifier,
        idToken: await sign('oidc@example.test', started.data.nonce, 'wrong-audience'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    await expect(
      service.oidcComplete({
        challengeId: started.data.challengeId,
        verifier,
        idToken: await sign('owner@example.test'),
      }),
    ).rejects.toMatchObject({ code: 'LINK_REQUIRED' });
    const created = await service.oidcComplete({
      challengeId: started.data.challengeId,
      verifier,
      idToken: await sign('oidc@example.test'),
    });
    expect(created.userId).toBeTruthy();
    await expect(
      service.oidcComplete({
        challengeId: started.data.challengeId,
        verifier,
        idToken: await sign('oidc@example.test'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
  });
});
