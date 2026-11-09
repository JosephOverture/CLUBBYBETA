import { randomUUID } from 'node:crypto';
import { mkdtemp, cp, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ClubbyClient } from '@clubby/api-client';
import { createApplication } from '../apps/api/src/bootstrap';
import { readConfig } from '../apps/api/src/platform/config';
import { Database } from '../apps/api/src/platform/database';
import { migrate } from '../apps/api/src/platform/migrations';
import { enqueue, JobQueue, platformHandlers } from '../apps/api/src/platform/jobs';
import { isolatedDatabase } from './database-helper';

describe.skipIf(!process.env.TEST_DATABASE_URL)('foundation with real PostgreSQL connections', () => {
  let db: Database;
  let app: NestFastifyApplication;
  let apiUrl: string;
  let dispose: () => Promise<void>;
  const migrations = resolve('database/migrations');
  beforeAll(async () => {
    ({ db, dispose } = await isolatedDatabase());
    await migrate(db, migrations);
    await db.query(`INSERT INTO destinations(id,name,country_code,timezone,currency,published)
      VALUES('milan','Milan','IT','Europe/Rome','EUR',true) ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO venues(id,destination_id,name,status,demo) VALUES('alcatraz','milan','Alcatraz','published',true),
      ('hidden-foundation','milan','Hidden','hidden',true) ON CONFLICT DO NOTHING`);
    app = await createApplication(db.config, db);
    await app.listen(0, '127.0.0.1');
    apiUrl = await app.getUrl();
  });
  afterAll(async () => {
    if (app) await app.close();
    else if (db) await db.onApplicationShutdown();
    if (dispose) await dispose();
  });

  it('migrates idempotently under concurrent migration runners and reports readiness', async () => {
    await Promise.all([migrate(db, migrations), migrate(db, migrations)]);
    expect(await db.ready()).toBe(true);
    expect((await app.inject('/health/ready')).statusCode).toBe(200);
  });
  it('documents actual command statuses, idempotency headers and authoritative purchase schemas', async () => {
    const response = await app.inject('/v1/openapi.json'),
      spec = response.json();
    expect(spec.paths['/v1/auth/email/start'].post.responses['202']).toBeDefined();
    const hold = spec.paths['/v1/orders'].post;
    expect(hold.responses['201']).toBeDefined();
    expect(hold.parameters).toContainEqual({
      name: 'idempotency-key',
      in: 'header',
      required: true,
      schema: { type: 'string' },
    });
    expect(hold.requestBody.content['application/json'].schema.required).toContain('items');
    expect(hold.requestBody.content['application/json'].schema.properties.totalMinor).toBeUndefined();
  });
  it('keeps the preceding artifact ready after additive migrations but rejects altered known history', async () => {
    await db.query("INSERT INTO schema_migrations(filename,checksum) VALUES('999_future_additive.sql',$1)", [
      'a'.repeat(64),
    ]);
    try {
      expect(await db.ready()).toBe(true);
      const original = (
        await db.query("SELECT checksum FROM schema_migrations WHERE filename='001_platform.sql'")
      ).rows[0]!.checksum;
      try {
        await db.query("UPDATE schema_migrations SET checksum=$1 WHERE filename='001_platform.sql'", [
          'b'.repeat(64),
        ]);
        expect(await db.ready()).toBe(false);
      } finally {
        await db.query("UPDATE schema_migrations SET checksum=$1 WHERE filename='001_platform.sql'", [
          original,
        ]);
      }
    } finally {
      await db.query("DELETE FROM schema_migrations WHERE filename='999_future_additive.sql'");
    }
  });
  it('rejects changed applied migrations', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'clubby-migration-test-'));
    try {
      await cp(migrations, folder, { recursive: true });
      await appendFile(join(folder, '001_platform.sql'), '\n-- modified');
      await expect(migrate(db, folder)).rejects.toThrow('Changed applied migration');
    } finally {
      const checked = resolve(folder);
      if (!checked.startsWith(resolve(tmpdir(), 'clubby-migration-test-')))
        throw new Error('Unsafe temporary path.');
      await rm(checked, { recursive: true, force: true });
    }
  });
  it('rejects using a database from another environment', async () => {
    const other = new Database({ ...db.config, APP_ENV: 'development' });
    try {
      await expect(migrate(other, migrations)).rejects.toThrow('different environment');
      expect(await other.ready()).toBe(false);
    } finally {
      await other.onApplicationShutdown();
    }
  });
  it('web and iOS SDKs consume the same published DB venue', async () => {
    const web = new ClubbyClient(apiUrl, { channel: 'web' });
    const ios = new ClubbyClient(apiUrl, { channel: 'ios' });
    expect(await web.venue('alcatraz')).toEqual(await ios.venue('alcatraz'));
    expect((await ios.bootstrap()).data.capabilities.nativeCheckout).toBe(false);
    expect((await web.venues()).data.some((v) => v.id === 'hidden-foundation')).toBe(false);
    await expect(ios.venue('hidden-foundation')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
  it('hides private routes and returns validated errors/security headers', async () => {
    const bad = await app.inject('/v1/venues?city=%27%20OR%201=1');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_REQUEST');
    expect(bad.headers['x-content-type-options']).toBe('nosniff');
    expect(bad.headers['x-request-id']).toBeTruthy();
    expect((await app.inject('/v1/manager/personas')).statusCode).toBe(404);
    const cors = await app.inject({ url: '/v1/bootstrap', headers: { origin: 'https://attacker.example' } });
    expect(cors.headers['access-control-allow-origin']).toBeUndefined();
    const oversized = await app.inject({
      method: 'POST',
      url: '/v1/venues',
      payload: 'x'.repeat(70_000),
      headers: { 'content-type': 'application/json' },
    });
    expect(oversized.statusCode).toBe(413);
    expect((await app.inject('/v1/openapi.json')).json().paths['/v1/venues/{id}']).toBeDefined();
  });
  it('rolls back business data and its outbox atomically', async () => {
    const key = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        await enqueue(tx, 'platform.probe', key, { id: key });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await db.query('SELECT id FROM outbox_jobs WHERE dedupe_key=$1', [key])).rowCount).toBe(0);
  });
  it('deduplicates jobs and rejects changed payloads', async () => {
    const key = randomUUID();
    const first = await db.transaction((tx) => enqueue(tx, 'platform.probe', key, { a: 1, b: 2 }));
    const second = await db.transaction((tx) => enqueue(tx, 'platform.probe', key, { b: 2, a: 1 }));
    expect(second).toBe(first);
    await expect(db.transaction((tx) => enqueue(tx, 'platform.probe', key, { a: 2 }))).rejects.toThrow(
      'different data',
    );
  });
  it('multiple workers apply each committed effect once', async () => {
    for (let i = 0; i < 8; i++)
      await db.transaction((tx) => enqueue(tx, 'platform.probe', randomUUID(), { n: i }));
    const queues = Array.from({ length: 4 }, () => new JobQueue(db, platformHandlers));
    while ((await Promise.all(queues.map((queue) => queue.tick()))).some(Boolean)) {
      /* Drain independent workers. */
    }
    const result = await db.query('SELECT count(*)::int AS count FROM platform_probe_results');
    expect(result.rows[0]?.count).toBe(9);
    expect((await db.query("SELECT id FROM outbox_jobs WHERE status != 'done'")).rowCount).toBe(0);
  });
  it('recovers an expired lease and fences the previous worker', async () => {
    const id = await db.transaction((tx) => enqueue(tx, 'platform.probe', randomUUID(), { recovery: true }));
    const queue = new JobQueue(db, platformHandlers);
    const stale = (await queue.claim())!;
    expect(stale.id).toBe(id);
    await db.query("UPDATE outbox_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [id]);
    const current = (await queue.claim())!;
    await queue.execute(stale);
    expect((await db.query('SELECT job_id FROM job_receipts WHERE job_id=$1', [id])).rowCount).toBe(0);
    await queue.execute(current);
    await queue.execute(current);
    expect((await db.query('SELECT job_id FROM job_receipts WHERE job_id=$1', [id])).rowCount).toBe(1);
  });
  it('dead-letters bounded failures without leaking the handler error', async () => {
    const id = await db.transaction((tx) => enqueue(tx, 'broken', randomUUID(), {}, 1));
    const queue = new JobQueue(db, {
      broken: async () => {
        throw new Error('secret-token');
      },
    });
    await queue.tick();
    const result = await db.query('SELECT status,error_code FROM outbox_jobs WHERE id=$1', [id]);
    expect(result.rows[0]).toEqual({ status: 'dead', error_code: 'HANDLER_FAILED' });
    expect((await db.query('SELECT job_id FROM job_receipts WHERE job_id=$1', [id])).rowCount).toBe(0);
  });
  it('renews a slow external handler without holding database locks or allowing a competing claim', async () => {
    const id = await db.transaction((tx) => enqueue(tx, 'slow.external', randomUUID(), {}));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((done) => {
        entered = done;
      }),
      held = new Promise<void>((done) => {
        release = done;
      });
    const queue = new JobQueue(
      db,
      {},
      {
        'slow.external': async () => {
          entered();
          await held;
        },
      },
      { leaseMs: 1000, renewalMs: 100 },
    );
    const job = (await queue.claim())!;
    expect(job.id).toBe(id);
    const execution = queue.execute(job);
    await started;
    try {
      await new Promise((done) => setTimeout(done, 1300));
      expect(
        (await db.query('SELECT (lease_until>clock_timestamp()) AS valid FROM outbox_jobs WHERE id=$1', [id]))
          .rows[0]!.valid,
      ).toBe(true);
      expect(await new JobQueue(db, {}).claim()).toBeUndefined();
      await db.transaction(async (tx) => {
        await tx.query("SET LOCAL lock_timeout='100ms'");
        await tx.query('SELECT id FROM outbox_jobs WHERE id=$1 FOR UPDATE', [id]);
      });
    } finally {
      release();
      await execution;
    }
    expect((await db.query('SELECT status FROM outbox_jobs WHERE id=$1', [id])).rows[0]!.status).toBe('done');
  });
  it('does not revive a lost lease or record stale external completion', async () => {
    const id = await db.transaction((tx) => enqueue(tx, 'lost.external', randomUUID(), {}));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((done) => {
        entered = done;
      }),
      held = new Promise<void>((done) => {
        release = done;
      });
    const staleQueue = new JobQueue(
      db,
      {},
      {
        'lost.external': async () => {
          entered();
          await held;
        },
      },
      { leaseMs: 1000, renewalMs: 100 },
    );
    const stale = (await staleQueue.claim())!,
      execution = staleQueue.execute(stale);
    await started;
    await db.query("UPDATE outbox_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [
      id,
    ]);
    await new Promise((done) => setTimeout(done, 200));
    const replacement = new JobQueue(db, {}, { 'lost.external': async () => {} }),
      current = (await replacement.claim())!;
    expect(current.lease_token).not.toBe(stale.lease_token);
    release();
    await execution;
    expect((await db.query('SELECT job_id FROM job_receipts WHERE job_id=$1', [id])).rowCount).toBe(0);
    await replacement.execute(current);
    expect((await db.query('SELECT status FROM outbox_jobs WHERE id=$1', [id])).rows[0]!.status).toBe('done');
  });
});
