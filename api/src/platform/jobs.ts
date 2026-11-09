import { createHash, randomUUID } from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';
import type { PoolClient } from 'pg';
import type { Database } from './database';

export type Job = {
  id: string;
  topic: string;
  payload: unknown;
  lease_token: string;
  attempts: number;
  max_attempts: number;
};
export type TransactionalHandler = (client: PoolClient, payload: unknown, jobId: string) => Promise<void>;
export type ExternalHandler = (payload: unknown, jobId: string) => Promise<void>;
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export async function enqueue(
  client: PoolClient,
  topic: string,
  dedupeKey: string,
  payload: unknown,
  maxAttempts = 8,
) {
  const json = canonical(payload);
  const hash = createHash('sha256').update(json).digest('hex');
  const result = await client.query<{ id: string; payload_hash: string }>(
    `
    INSERT INTO outbox_jobs(id,topic,dedupe_key,payload,payload_hash,max_attempts) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(topic,dedupe_key) DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
    RETURNING id,payload_hash`,
    [randomUUID(), topic, dedupeKey, json, hash, maxAttempts],
  );
  if (result.rows[0]?.payload_hash !== hash)
    throw new Error('Job idempotency key was reused with different data.');
  return result.rows[0].id;
}

export class JobQueue {
  private readonly leaseMs: number;
  private readonly renewalMs: number;
  constructor(
    private readonly db: Database,
    private readonly handlers: Record<string, TransactionalHandler>,
    private readonly externalHandlers: Record<string, ExternalHandler> = {},
    options: { leaseMs?: number; renewalMs?: number } = {},
  ) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.renewalMs = options.renewalMs ?? 10_000;
    if (
      !Number.isInteger(this.leaseMs) ||
      this.leaseMs < 500 ||
      this.leaseMs > 300_000 ||
      !Number.isInteger(this.renewalMs) ||
      this.renewalMs < 50 ||
      this.renewalMs >= this.leaseMs / 2
    )
      throw new Error('Invalid worker lease timing.');
  }
  async claim(): Promise<Job | undefined> {
    return this.db.transaction(async (client) => {
      await client.query(`UPDATE outbox_jobs SET status='dead',lease_token=NULL,lease_until=NULL,error_code='ATTEMPTS_EXHAUSTED'
        WHERE status='processing' AND lease_until < clock_timestamp() AND attempts >= max_attempts`);
      const result = await client.query<Job>(
        `WITH candidate AS (
        SELECT id FROM outbox_jobs WHERE attempts < max_attempts AND
          ((status='queued' AND available_at <= clock_timestamp()) OR (status='processing' AND lease_until < clock_timestamp()))
        ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE outbox_jobs j SET status='processing',attempts=j.attempts+1,lease_token=$1,
          lease_until=clock_timestamp()+$2::int*interval '1 millisecond'
        FROM candidate c WHERE j.id=c.id RETURNING j.*`,
        [randomUUID(), this.leaseMs],
      );
      return result.rows[0];
    });
  }
  async execute(job: Job) {
    try {
      const external = this.externalHandlers[job.topic];
      if (external) {
        const owned = await this.db.query(
          "SELECT id FROM outbox_jobs WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp()",
          [job.id, job.lease_token],
        );
        if (!owned.rowCount) return;
        // No database locks span the network request. Provider idempotency uses the immutable job ID.
        let lost = false,
          flight: Promise<void> | undefined;
        const timer = setInterval(() => {
          if (flight || lost) return;
          flight = this.db
            .query(
              "UPDATE outbox_jobs SET lease_until=clock_timestamp()+$3::int*interval '1 millisecond' WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp() RETURNING id",
              [job.id, job.lease_token, this.leaseMs],
            )
            .then((result) => {
              if (!result.rowCount) lost = true;
            })
            .catch(() => {
              lost = true;
            })
            .finally(() => {
              flight = undefined;
            });
        }, this.renewalMs);
        try {
          await external(job.payload, job.id);
        } finally {
          clearInterval(timer);
          await flight;
        }
        // Renewal cannot revive an expired lease. A replacement worker owns completion after loss.
        if (lost) return;
      }
      await this.db.transaction(async (client) => {
        const lock = await client.query(
          `SELECT id FROM outbox_jobs WHERE id=$1 AND lease_token=$2 AND status='processing'
          AND lease_until > clock_timestamp() FOR UPDATE`,
          [job.id, job.lease_token],
        );
        if (!lock.rowCount) return;
        const handler = this.handlers[job.topic];
        if (!handler && !external) throw new Error('Unknown job type.');
        const receipt = await client.query(
          'INSERT INTO job_receipts(job_id,handler) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING job_id',
          [job.id, job.topic],
        );
        // Only bounded database effects belong here. Provider calls use dedicated out-of-transaction handlers.
        if (receipt.rowCount && handler) await handler(client, job.payload, job.id);
        await client.query(
          `UPDATE outbox_jobs SET status='done',completed_at=now(),lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=$1`,
          [job.id],
        );
      });
    } catch {
      await this.db.query(
        `UPDATE outbox_jobs SET status=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'queued' END,
        available_at=clock_timestamp()+least(300,power(2,attempts))*interval '1 second',
        lease_token=NULL,lease_until=NULL,error_code='HANDLER_FAILED'
        WHERE id=$1 AND lease_token=$2 AND status='processing'`,
        [job.id, job.lease_token],
      );
    }
  }
  async tick() {
    const job = await this.claim();
    if (job) await this.execute(job);
    return Boolean(job);
  }
}
export const platformHandlers: Record<string, TransactionalHandler> = {
  'platform.probe': async (client, payload, id) => {
    await client.query(
      'INSERT INTO platform_probe_results(job_id,value) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [id, JSON.stringify(payload)],
    );
  },
};
