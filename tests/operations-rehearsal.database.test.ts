import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import { commerceFixture } from './commerce-fixture';
import { isolatedDatabase } from './database-helper';
import { InventoryService } from '../apps/api/src/commerce/inventory.service';
import { OrdersService } from '../apps/api/src/commerce/orders.service';
import { AdmissionsService } from '../apps/api/src/commerce/admissions.service';
import { enqueue, JobQueue, platformHandlers } from '../apps/api/src/platform/jobs';
import type { Database } from '../apps/api/src/platform/database';
import { rotateEncryption } from '../apps/api/src/platform/encryption-rotation';
import { decrypt } from '../apps/api/src/platform/crypto';

const evidence: Record<string, unknown> = {};
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    requests: values.length,
    p50Ms: Math.round(sorted[Math.ceil(sorted.length * 0.5) - 1]!),
    p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]!),
    maxMs: Math.round(sorted.at(-1)!),
  };
}
async function pgTool(name: string, db: Database, args: string[]) {
  const binary = process.env.PG_BIN_DIR
    ? join(process.env.PG_BIN_DIR, name + (process.platform === 'win32' ? '.exe' : ''))
    : process.platform === 'win32'
      ? resolve('.local-data/pg-tools', name + '.exe')
      : name;
  const url = new URL(db.config.DATABASE_URL);
  await new Promise<void>((accept, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        PGHOST: url.hostname,
        PGPORT: url.port || '5432',
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGDATABASE: url.pathname.slice(1),
        PGCONNECT_TIMEOUT: '5',
      },
    });
    let message = '';
    child.stderr.on('data', (chunk) => {
      message += chunk;
    });
    child.on('error', () => reject(new Error('PostgreSQL 17 backup tools unavailable; set PG_BIN_DIR.')));
    child.on('exit', (code) =>
      code === 0
        ? accept()
        : reject(
            new Error(
              `${name} failed (${code}): ${message.replaceAll(decodeURIComponent(url.password), '[redacted]')}`,
            ),
          ),
    );
  });
}
async function fingerprint(db: Database) {
  const tables = (
    await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  ).rows;
  const records: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    if (!/^[a-z_]+$/.test(tablename)) throw new Error('Unexpected table identifier.');
    records[tablename] = (
      await db.query(
        `SELECT count(*)::int AS rows, md5(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text)) AS digest FROM "${tablename}" t`,
      )
    ).rows[0];
  }
  return records;
}
describe.skipIf(!process.env.TEST_DATABASE_URL)('local capacity and actual backup recovery rehearsal', () => {
  let f: Awaited<ReturnType<typeof commerceFixture>>;
  beforeAll(async () => {
    f = await commerceFixture({ HTTP_RATE_LIMIT: '10000' });
  });
  afterAll(async () => {
    if (f) await f.close();
    await mkdir('.local-data/evidence', { recursive: true });
    await writeFile(
      '.local-data/evidence/operations-rehearsal.json',
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          environment: 'disposable local PostgreSQL; payment provider double',
          ...evidence,
        },
        null,
        2,
      ),
    );
  });
  it('handles competing web/iOS buyers and concurrent duplicate admission scans without overselling', async () => {
    const occurrence = await f.offer();
    await f.db.query(
      "UPDATE occurrences SET starts_at=now()+interval '2 hours',ends_at=now()+interval '6 hours' WHERE id=$1",
      [occurrence.occurrenceId],
    );
    const product = await f.app.get(InventoryService).product(f.owner.principal, occurrence.occurrenceId, {
      name: 'Onsale rehearsal',
      priceMinor: 1250,
      taxBps: 2200,
      capacity: 20,
      drinks: 0,
      saleStartsAt: new Date(Date.now() - 3600_000).toISOString(),
      saleEndsAt: new Date(Date.now() + 3600_000).toISOString(),
      active: true,
    });
    const buyers = await Promise.all(Array.from({ length: 40 }, (_, i) => f.actor(i % 2 ? 'ios' : 'web')));
    const durations: number[] = [];
    const holds = await Promise.all(
      buyers.map(async (buyer, i) => {
        const start = performance.now();
        const headers: Record<string, string> =
          i % 2
            ? { authorization: `Bearer ${buyer.credentials.token}` }
            : {
                cookie: `clubby_session=${buyer.credentials.token}`,
                origin: 'http://localhost:8081',
                'x-csrf-token': buyer.credentials.csrfToken,
              };
        const response = await f.app.inject({
          method: 'POST',
          url: '/v1/orders',
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: {
            occurrenceId: occurrence.occurrenceId,
            items: [{ productId: product.data!.id, quantity: 1 }],
            email: buyer.email,
          },
        });
        durations.push(performance.now() - start);
        return { response, buyer };
      }),
    );
    const accepted = holds.filter((r) => r.response.statusCode === 201);
    expect(accepted).toHaveLength(20);
    expect(holds.filter((r) => r.response.statusCode === 409)).toHaveLength(20);
    evidence.onsale = { concurrency: 40, stock: 20, accepted: 20, rejected: 20, ...stats(durations) };
    const orders = f.app.get(OrdersService),
      admissions = f.app.get(AdmissionsService);
    const tickets = await Promise.all(
      accepted.map(async ({ response, buyer }) => {
        const id = response.json().data.id,
          started = await orders.startPayment(buyer.principal, id, true);
        if (!('paymentIntentId' in started.data)) throw new Error('Payment attempt missing.');
        await orders.applyPayment(
          f.provider.sellerValue.id,
          f.provider.succeed(started.data.paymentIntentId),
        );
        const view = await orders.view(buyer.principal, id);
        return (await admissions.ticket(buyer.principal, view.data.tickets[0]!.id)).data;
      }),
    );
    const scans: number[] = [];
    const outcomes = await Promise.all(
      [...tickets, ...tickets].map(async (ticket) => {
        const start = performance.now();
        const result = await f.app.inject({
          method: 'POST',
          url: '/v1/admissions/scan',
          headers: { authorization: `Bearer ${f.owner.credentials.token}`, 'idempotency-key': randomUUID() },
          payload: {
            occurrenceId: occurrence.occurrenceId,
            credential: ticket.credential,
            kind: 'admission',
          },
        });
        scans.push(performance.now() - start);
        expect(result.statusCode, result.body).toBe(201);
        return result.json().data.outcome;
      }),
    );
    expect(outcomes.filter((v) => v === 'accepted')).toHaveLength(20);
    expect(outcomes.filter((v) => v === 'already-admitted')).toHaveLength(20);
    evidence.admissions = { concurrency: 40, accepted: 20, duplicateRejected: 20, ...stats(scans) };
    const reads: number[] = [];
    for (let batch = 0; batch < 10; batch++)
      await Promise.all(
        Array.from({ length: 10 }, async () => {
          const start = performance.now();
          const result = await f.app.inject('/v1/venues/group-venue');
          expect(result.statusCode).toBe(200);
          reads.push(performance.now() - start);
        }),
      );
    evidence.catalogue = { concurrency: 10, ...stats(reads) };
    expect(Math.max(...scans, ...reads)).toBeLessThan(5000);
    expect(
      (await f.db.query('SELECT count(*)::int AS count FROM tickets WHERE admitted_at IS NOT NULL')).rows[0]!
        .count,
    ).toBe(20);
  }, 30000);
  it('dumps and restores every table, then resumes a stranded job exactly once', async () => {
    const restore = await isolatedDatabase({ APP_ENCRYPTION_KEY: f.db.config.APP_ENCRYPTION_KEY });
    const folder = await mkdtemp(join(tmpdir(), 'clubby-recovery-')),
      archive = join(folder, 'snapshot.dump');
    const marker = randomUUID();
    await f.db.transaction((tx) => enqueue(tx, 'platform.probe', marker, { marker }));
    const oldQueue = new JobQueue(f.db, platformHandlers),
      stranded = await oldQueue.claim();
    // The oldest available job may be a commerce notification. Claim the probe explicitly for this crash fixture.
    await f.db.query(
      "UPDATE outbox_jobs SET status='processing',lease_token=$2,lease_until=clock_timestamp()-interval '1 second' WHERE topic='platform.probe' AND dedupe_key=$1",
      [marker, randomUUID()],
    );
    if (stranded)
      await f.db.query(
        "UPDATE outbox_jobs SET status='queued',lease_token=NULL,lease_until=NULL WHERE id=$1 AND topic<>'platform.probe'",
        [stranded.id],
      );
    const before = await fingerprint(f.db),
      start = performance.now();
    try {
      await pgTool('pg_dump', f.db, ['--format=custom', '--no-owner', '--no-privileges', '--file', archive]);
      await pgTool('pg_restore', restore.db, [
        '--dbname',
        new URL(restore.db.config.DATABASE_URL).pathname.slice(1),
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        archive,
      ]);
      expect(await restore.db.ready()).toBe(true);
      expect(await fingerprint(restore.db)).toEqual(before);
      const queue = new JobQueue(restore.db, platformHandlers);
      // Isolate the durable probe from other domain handlers in this focused recovery assertion.
      await restore.db.query(
        "UPDATE outbox_jobs SET available_at=clock_timestamp()+interval '1 hour' WHERE status='queued' AND topic<>'platform.probe'",
      );
      const recovered = await queue.claim();
      expect(recovered?.topic).toBe('platform.probe');
      await queue.execute(recovered!);
      await queue.execute(recovered!);
      expect(
        (
          await restore.db.query(
            "SELECT count(*)::int AS count FROM platform_probe_results WHERE value->>'marker'=$1",
            [marker],
          )
        ).rows[0]!.count,
      ).toBe(1);
      evidence.restore = {
        tables: Object.keys(before).length,
        tableFingerprintsMatch: true,
        paidAdmissions: 20,
        strandedJobRecoveredOnce: true,
        elapsedMs: Math.round(performance.now() - start),
      };
    } finally {
      await restore.db.onApplicationShutdown();
      await restore.dispose();
      const target = resolve(folder);
      if (!target.startsWith(resolve(tmpdir(), 'clubby-recovery-'))) throw new Error('Unsafe cleanup path.');
      await rm(target, { recursive: true, force: true });
    }
  }, 30000);
  it('rolls back the entire encryption maintenance operation if any stored ciphertext is corrupt', async () => {
    const db = Object.create(f.db) as Database;
    Object.defineProperty(db, 'config', {
      value: { ...f.db.config, encryptionKeys: ['c3'.repeat(32), ...f.db.config.encryptionKeys] },
    });
    await f.db.query('CREATE TABLE zz_rotation_fixture (value_encrypted text)');
    try {
      await f.db.query("INSERT INTO zz_rotation_fixture VALUES('corrupt')");
      const before = await fingerprint(f.db);
      await expect(rotateEncryption(db)).rejects.toThrow();
      expect(await fingerprint(f.db)).toEqual(before);
      evidence.corruptRotationRolledBack = true;
    } finally {
      await f.db.query('DROP TABLE zz_rotation_fixture');
    }
  });
  it('rewraps stored secrets atomically without changing financial records or admission credentials', async () => {
    const next = 'c3'.repeat(32);
    const db = Object.create(f.db) as Database;
    Object.defineProperty(db, 'config', {
      value: { ...f.db.config, encryptionKeys: [next, ...f.db.config.encryptionKeys] },
    });
    const financeBefore = (await f.db.query('SELECT * FROM ledger_postings ORDER BY id')).rows;
    const sample = (
      await f.db.query('SELECT credential_hash,credential_encrypted FROM tickets ORDER BY id LIMIT 1')
    ).rows[0]!;
    const plaintext = decrypt(sample.credential_encrypted, f.db.config.encryptionKeys);
    const rotated = await rotateEncryption(db);
    expect(rotated.rewrapped).toBeGreaterThan(20);
    expect((await rotateEncryption(db)).rewrapped).toBe(0);
    const current = (
      await f.db.query('SELECT credential_hash,credential_encrypted FROM tickets ORDER BY id LIMIT 1')
    ).rows[0]!;
    expect(current.credential_hash).toBe(sample.credential_hash);
    expect(decrypt(current.credential_encrypted, next)).toEqual(plaintext);
    expect(() => decrypt(current.credential_encrypted, f.db.config.encryptionKeys)).toThrow();
    expect((await f.db.query('SELECT * FROM ledger_postings ORDER BY id')).rows).toEqual(financeBefore);
    evidence.encryptionRotation = {
      columns: rotated.columns,
      rewrapped: rotated.rewrapped,
      retryChangedRecords: 0,
      financialEntriesUnchanged: true,
    };
  });
});
