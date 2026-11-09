import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { commerceFixture } from './commerce-fixture';
import { enqueue, JobQueue, platformHandlers } from '../apps/api/src/platform/jobs';
import { WorkerHealth } from '../apps/api/src/platform/worker-health';
import { rateStore } from '../apps/api/src/platform/rate-limit';
describe.skipIf(!process.env.TEST_DATABASE_URL)('operational health and guarded recovery', () => {
  let f: Awaited<ReturnType<typeof commerceFixture>>;
  beforeAll(async () => {
    f = await commerceFixture();
  });
  afterAll(async () => {
    if (f) await f.close();
  });
  const headers = (actor: typeof f.admin) => ({ authorization: `Bearer ${actor.credentials.token}` });
  it('shares one atomic rate budget across replicas and resets an expired window', async () => {
    const Store = rateStore(f.db),
      stores = [new Store(), new Store()];
    const key = randomUUID();
    const hit = (i: number) =>
      new Promise<{ current: number; ttl: number }>((resolve, reject) => {
        stores[i % 2]!.incr(key, (error, result) => (error ? reject(error) : resolve(result!)), 60000, 30);
      });
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => hit(i)));
    expect(results.filter((r) => r.current <= 30)).toHaveLength(30);
    expect(results.every((r) => r.ttl > 0 && r.ttl <= 60000)).toBe(true);
    const stored = (await f.db.query('SELECT key_hash FROM http_rate_windows')).rows;
    expect(stored.every((r) => r.key_hash.length === 64 && r.key_hash !== key)).toBe(true);
    await f.db.query("UPDATE http_rate_windows SET expires_at=clock_timestamp()-interval '1 second'");
    expect((await hit(0)).current).toBe(1);
  });
  it('reports worker and maintenance health without disclosing internal configuration', async () => {
    const health = new WorkerHealth(f.db, randomUUID()),
      port = await health.start(0, '127.0.0.1');
    try {
      expect((await fetch(`http://127.0.0.1:${port}/health/ready`)).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${port}/health/live`)).status).toBe(200);
      await health.maintained();
      expect((await fetch(`http://127.0.0.1:${port}/health/ready`)).status).toBe(200);
      const response = await f.app.inject({ url: '/v1/admin/operations', headers: headers(f.admin) });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toMatchObject({ workers: 1, maintained_workers: 1 });
      expect(response.body).not.toContain('sk_test');
      expect(response.body).not.toContain('password');
      expect(
        (await f.app.inject({ url: '/v1/admin/operations', headers: headers(f.owner) })).statusCode,
      ).toBe(403);
      expect((await f.app.inject({ url: '/v1/admin/operations' })).statusCode).toBe(401);
    } finally {
      await health.close();
    }
    expect((await f.db.query('SELECT id FROM worker_heartbeats')).rowCount).toBe(0);
  });
  it('keeps payloads private, fences repeated replay and requires domain recovery for financial jobs', async () => {
    const id = await f.db.transaction((tx) =>
      enqueue(tx, 'platform.probe', randomUUID(), { private: 'test-only-sensitive-payload' }, 1),
    );
    await f.db.query(
      "UPDATE outbox_jobs SET status='dead',attempts=1,error_code='HANDLER_FAILED' WHERE id=$1",
      [id],
    );
    const response = await f.app.inject({ url: '/v1/admin/operations/jobs', headers: headers(f.admin) });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('test-only-sensitive-payload');
    expect(response.json().data.find((r: any) => r.id === id)).toMatchObject({
      replayable: true,
      replay_generation: 0,
    });
    const command = {
      method: 'POST' as const,
      url: `/v1/admin/operations/jobs/${id}/replay`,
      payload: { expectedGeneration: 0, reason: 'Underlying failure repaired and verified' },
    };
    expect((await f.app.inject({ ...command, headers: headers(f.owner) })).statusCode).toBe(403);
    expect((await f.app.inject({ ...command, headers: headers(f.admin) })).statusCode).toBe(201);
    expect((await f.app.inject({ ...command, headers: headers(f.admin) })).statusCode).toBe(409);
    const queue = new JobQueue(f.db, platformHandlers);
    const job = (
      await f.db.query(
        "UPDATE outbox_jobs SET status='processing',lease_token=$2,lease_until=clock_timestamp()+interval '30 seconds',attempts=1 WHERE id=$1 RETURNING *",
        [id, randomUUID()],
      )
    ).rows[0]!;
    await queue.execute(job as any);
    expect(
      (await f.db.query('SELECT job_id FROM platform_probe_results WHERE job_id=$1', [id])).rowCount,
    ).toBe(1);
    const financial = await f.db.transaction((tx) =>
      enqueue(tx, 'refund.process', randomUUID(), { refundId: randomUUID() }, 1),
    );
    await f.db.query("UPDATE outbox_jobs SET status='dead',attempts=1 WHERE id=$1", [financial]);
    const denied = await f.app.inject({
      ...command,
      url: `/v1/admin/operations/jobs/${financial}/replay`,
      headers: headers(f.admin),
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe('DOMAIN_RECOVERY_REQUIRED');
    expect(
      (
        await f.db.query("SELECT id FROM audit_events WHERE action='operations.replay' AND resource_id=$1", [
          id,
        ])
      ).rowCount,
    ).toBe(1);
  });
});
