import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApplication } from '../apps/api/src/bootstrap';
import { Database } from '../apps/api/src/platform/database';
import { migrate } from '../apps/api/src/platform/migrations';
import { betaDateSchema } from '../apps/api/src/beta/beta.service';
import { isolatedDatabase } from './database-helper';

describe('beta personal plan dates', () => {
  it('accepts real calendar dates and rejects calendar overflow and extra timestamps', () => {
    expect(betaDateSchema.safeParse('2028-02-29').success).toBe(true);
    for (const value of ['2027-02-29', '2030-02-31', '2030-13-01', '0000-01-01', '2030-01-01T00:00:00Z'])
      expect(betaDateSchema.safeParse(value).success).toBe(false);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('public beta persistence on PostgreSQL', () => {
  let app: NestFastifyApplication, db: Database, dispose: () => Promise<void>;
  const origin = 'http://localhost:8081';
  let visitorA: string, visitorB: string;
  const cookieOf = (response: { headers: Record<string, unknown> }) => {
    const value = response.headers['set-cookie'];
    return String(Array.isArray(value) ? value[0] : value).split(';')[0]!;
  };
  const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { origin, cookie }, ...(payload === undefined ? {} : { payload }) });

  beforeAll(async () => {
    ({ db, dispose } = await isolatedDatabase());
    await migrate(db, resolve('database/migrations'));
    await db.query(`INSERT INTO destinations(id,name,country_code,timezone,currency,published)
      VALUES('beta-milan','Milan','IT','Europe/Rome','EUR',true),
            ('beta-hidden','Hidden market','IT','Europe/Rome','EUR',false)`);
    await db.query(`INSERT INTO venues(id,destination_id,name,status)
      VALUES('beta-club','beta-milan','Beta Club','published'),
            ('beta-other','beta-milan','Another Club','published'),
            ('beta-draft','beta-milan','Draft club','draft'),
            ('beta-hidden-club','beta-hidden','Hidden club','published')`);
    app = await createApplication(db.config, db);
    visitorA = cookieOf(await app.inject('/v1/beta/state'));
    visitorB = cookieOf(await app.inject('/v1/beta/state'));
  });
  afterAll(async () => {
    if (app) await app.close();
    else if (db) await db.onApplicationShutdown();
    if (dispose) await dispose();
  });

  it('uses an opaque HttpOnly cookie and keeps only its digest in storage', async () => {
    const response = await app.inject('/v1/beta/state');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { saved: [], plans: [], profile: { name: 'Guest', theme: 'dark' } } });
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/v1/beta');
    const token = cookieOf(response).split('=')[1]!;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const hash = createHash('sha256').update(token).digest('hex');
    expect((await db.query('SELECT token_hash FROM beta_visitors WHERE token_hash=$1', [token])).rowCount).toBe(0);
    expect((await db.query('SELECT token_hash FROM beta_visitors WHERE token_hash=$1', [hash])).rowCount).toBe(1);
  });

  it('requires an allowed Origin for every write, including empty-body deletes', async () => {
    for (const headers of [{ cookie: visitorA }, { cookie: visitorA, origin: 'https://untrusted.example' }, { cookie: visitorA, origin: 'null' }]) {
      const save = await app.inject({ method: 'PUT', url: '/v1/beta/saved/beta-club', headers, payload: { saved: true } });
      expect(save.statusCode).toBe(403);
      const reset = await app.inject({ method: 'DELETE', url: '/v1/beta/state', headers });
      expect(reset.statusCode).toBe(403);
    }
  });

  it('persists favorites, personal plans and preferences and never exposes another visitor', async () => {
    const save = await inject('PUT', '/v1/beta/saved/beta-club', visitorA, { saved: true });
    expect(save.statusCode).toBe(200);
    expect(save.json().data.saved).toEqual(['beta-club']);
    const repeat = await inject('PUT', '/v1/beta/saved/beta-club', visitorA, { saved: true });
    expect(repeat.json().data.saved).toEqual(['beta-club']);
    const plan = await inject('POST', '/v1/beta/plans', visitorA, { venueId: 'beta-club', name: 'Friday with friends', note: 'Meet outside', date: '2030-06-14' });
    expect(plan.statusCode).toBe(201);
    const savedPlan = plan.json().data.plans[0];
    expect(savedPlan).toMatchObject({ venueId: 'beta-club', name: 'Friday with friends', note: 'Meet outside', date: '2030-06-14', status: 'personal' });
    expect(savedPlan.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(Number.isFinite(Date.parse(savedPlan.createdAt))).toBe(true);
    const preference = await inject('PATCH', '/v1/beta/profile', visitorA, { name: 'Paco', theme: 'light' });
    expect(preference.statusCode).toBe(200);
    expect(preference.json().data.profile).toEqual({ name: 'Paco', theme: 'light' });
    expect((await inject('GET', '/v1/beta/state', visitorA)).json().data).toEqual(preference.json().data);
    expect((await inject('GET', '/v1/beta/state', visitorB)).json().data).toEqual({ saved: [], plans: [], profile: { name: 'Guest', theme: 'dark' } });
    const forgedDelete = await inject('DELETE', `/v1/beta/plans/${savedPlan.id}`, visitorB);
    expect(forgedDelete.statusCode).toBe(200);
    expect((await inject('GET', '/v1/beta/state', visitorA)).json().data.plans).toHaveLength(1);
  });

  it('rejects hidden venues, unknown fields, invalid values and calendar overflow', async () => {
    for (const venueId of ['beta-draft', 'beta-hidden-club', 'unknown-beta']) {
      expect((await inject('PUT', `/v1/beta/saved/${venueId}`, visitorA, { saved: true })).statusCode).toBe(404);
      expect((await inject('POST', '/v1/beta/plans', visitorA, { venueId, name: 'A plan', date: '2030-06-14' })).statusCode).toBe(404);
    }
    for (const payload of [
      { venueId: 'beta-club', name: 'Bad date', date: '2030-02-31' },
      { venueId: 'beta-club', name: '', date: '2030-06-14' },
      { venueId: 'beta-club', name: 'Not a booking', date: '2030-06-14', tableId: 'table-1' },
      { venueId: 'beta-club', name: 'Long note', date: '2030-06-14', note: 'x'.repeat(401) },
    ]) expect((await inject('POST', '/v1/beta/plans', visitorA, payload)).statusCode).toBe(400);
    expect((await inject('PUT', '/v1/beta/saved/beta-club', visitorA, { saved: 'yes' })).statusCode).toBe(400);
    expect((await inject('PATCH', '/v1/beta/profile', visitorA, { theme: 'surprise' })).statusCode).toBe(400);
    expect((await inject('PATCH', '/v1/beta/profile', visitorA, { name: 'x'.repeat(41) })).statusCode).toBe(400);
    expect((await inject('PATCH', '/v1/beta/profile', visitorA, {})).statusCode).toBe(400);
  });

  it('reads the same data from a newly constructed API and database pool', async () => {
    const independentDatabase = new Database(db.config);
    const independentApp = await createApplication(db.config, independentDatabase);
    try {
      const before = await inject('GET', '/v1/beta/state', visitorA);
      const after = await independentApp.inject({ url: '/v1/beta/state', headers: { cookie: visitorA } });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual(before.json());
      expect(after.headers['set-cookie']).toBeUndefined();
    } finally { await independentApp.close(); }
  });

  it('serializes concurrent writes so the plan limit cannot be bypassed', async () => {
    const cookie = cookieOf(await app.inject('/v1/beta/state'));
    const token = cookie.split('=')[1]!;
    const hash = createHash('sha256').update(token).digest('hex');
    await db.transaction(async (tx) => {
      for (let i = 0; i < 99; i++) await tx.query(
        "INSERT INTO beta_plans(id,visitor_hash,venue_id,name,plan_date) VALUES($1,$2,'beta-club','Existing plan','2030-06-14')",
        [randomUUID(), hash],
      );
    });
    const responses = await Promise.all([1, 2].map(() => inject('POST', '/v1/beta/plans', cookie, { venueId: 'beta-club', name: 'Last plan', date: '2030-06-14' })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect((await inject('GET', '/v1/beta/state', cookie)).json().data.plans).toHaveLength(100);
  });

  it('erases all private state and expires the cookie without affecting another visitor', async () => {
    await inject('PUT', '/v1/beta/saved/beta-other', visitorB, { saved: true });
    const reset = await inject('DELETE', '/v1/beta/state', visitorA);
    expect(reset.statusCode).toBe(200);
    expect(String(reset.headers['set-cookie'])).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect(reset.json().data).toEqual({ saved: [], plans: [], profile: { name: 'Guest', theme: 'dark' } });
    const token = visitorA.split('=')[1]!;
    const hash = createHash('sha256').update(token).digest('hex');
    expect((await db.query('SELECT 1 FROM beta_visitors WHERE token_hash=$1', [hash])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM beta_plans WHERE visitor_hash=$1', [hash])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM beta_saved_venues WHERE visitor_hash=$1', [hash])).rowCount).toBe(0);
    const replay = await inject('GET', '/v1/beta/state', visitorA);
    expect(replay.json()).toEqual(reset.json());
    expect(cookieOf(replay)).not.toBe(visitorA);
    expect((await inject('GET', '/v1/beta/state', visitorB)).json().data.saved).toEqual(['beta-other']);
  });
});
