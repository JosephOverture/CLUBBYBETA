import { z } from 'zod';
import { Database } from './database';
import { ApiError } from './http';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import type { Principal } from '../identity/identity.service';

// Financial, email and privacy attempts use their domain recovery procedures; a generic replay must not
// bypass provider idempotency expiry, consent, request versions, or erasure completion checks.
const replayable = new Set([
  'platform.probe',
  'catalogue.changed',
  'notification.publish',
  'media.process',
  'media.cleanup',
  'report.generate',
  'wallet.sync',
  'group.reconcile',
]);
export class OperationsService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
  ) {}
  async snapshot() {
    const row = (
      await this.db.query(`SELECT
      (SELECT count(*)::int FROM worker_heartbeats WHERE seen_at>clock_timestamp()-interval '90 seconds') AS workers,
      (SELECT count(*)::int FROM worker_heartbeats WHERE seen_at>clock_timestamp()-interval '90 seconds' AND maintenance_at>clock_timestamp()-interval '5 minutes') AS maintained_workers,
      (SELECT count(*)::int FROM outbox_jobs WHERE status='dead') AS dead_jobs,
      (SELECT count(*)::int FROM outbox_jobs WHERE status='queued' AND available_at<=clock_timestamp()) AS due_jobs,
      (SELECT coalesce(extract(epoch FROM clock_timestamp()-min(created_at)),0)::int FROM outbox_jobs WHERE status='queued' AND available_at<=clock_timestamp()) AS oldest_due_seconds,
      (SELECT count(*)::int FROM outbox_jobs WHERE status='processing' AND lease_until<clock_timestamp()) AS expired_leases,
      (SELECT count(*)::int FROM orders WHERE status='review') AS order_reviews,
      (SELECT count(*)::int FROM privacy_requests WHERE kind='delete' AND status NOT IN ('completed','cancelled') AND due_at<clock_timestamp()) AS overdue_deletions,
      (SELECT count(*)::int FROM refunds WHERE status='review') AS refund_reviews,
      clock_timestamp() AS observed_at`)
    ).rows[0]!;
    return {
      ...row,
      healthy:
        row.workers > 0 &&
        row.maintained_workers > 0 &&
        row.dead_jobs === 0 &&
        row.oldest_due_seconds < 300 &&
        row.overdue_deletions === 0,
    };
  }
  async status(actor: Principal) {
    await this.organizations.platform(actor);
    return { data: await this.snapshot() };
  }
  async jobs(actor: Principal, raw: unknown) {
    await this.organizations.platform(actor);
    const input = z
      .object({
        status: z.enum(['dead', 'queued', 'processing']).default('dead'),
        before: z.string().uuid().optional(),
      })
      .strict()
      .parse(raw);
    const rows = (
      await this.db.query(
        'SELECT id,topic,status,attempts,max_attempts,replay_generation,error_code,created_at,available_at,lease_until FROM outbox_jobs WHERE status=$1 AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT 51',
        [input.status, input.before ?? null],
      )
    ).rows;
    return {
      data: rows.slice(0, 50).map((row) => ({ ...row, replayable: replayable.has(row.topic) })),
      meta: { nextCursor: rows.length > 50 ? rows[49]!.id : null },
    };
  }
  async replay(actor: Principal, id: string, raw: unknown) {
    const input = z
      .object({
        expectedGeneration: z.number().int().nonnegative(),
        reason: z.string().trim().min(10).max(1000),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await this.organizations.platformAny(actor, ['admin'], tx);
      const job = (
        await tx.query(
          'SELECT topic,status,replay_generation,attempts FROM outbox_jobs WHERE id=$1 FOR UPDATE',
          [z.string().uuid().parse(id)],
        )
      ).rows[0];
      if (!job) throw new ApiError('NOT_FOUND', 'Job not found.', 404);
      if (!replayable.has(job.topic))
        throw new ApiError(
          'DOMAIN_RECOVERY_REQUIRED',
          'Use the booking, notification or privacy recovery workflow for this job.',
          409,
        );
      if (job.status !== 'dead' || job.replay_generation !== input.expectedGeneration)
        throw new ApiError('VERSION_CONFLICT', 'Job state changed. Refresh before retrying.', 409);
      await tx.query(
        "UPDATE outbox_jobs SET status='queued',attempts=0,available_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,error_code=NULL,replay_generation=replay_generation+1 WHERE id=$1",
        [id],
      );
      await audit(tx, actor.userId, 'operations.replay', 'job', id, input.reason, {
        topic: job.topic,
        generation: input.expectedGeneration + 1,
        previousAttempts: job.attempts,
      });
      return { data: { id, generation: input.expectedGeneration + 1 } };
    });
  }
}
