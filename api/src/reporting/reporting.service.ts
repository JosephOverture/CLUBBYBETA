import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { decrypt, encrypt } from '../platform/crypto';
import { enqueue } from '../platform/jobs';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import type { Principal } from '../identity/identity.service';
import { idempotent } from '../commerce/core';
import { timezoneSchema } from '../catalogue/catalogue.schemas';
import { idSchema } from '@clubby/contracts';

export const reportFilters = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    timezone: timezoneSchema,
    venueId: idSchema.optional(),
    occurrenceId: z.string().uuid().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  })
  .strict();
type Filters = z.infer<typeof reportFilters>;
type Reporter = Pick<Principal, 'userId' | 'kind'>;
type Scope = { organizationId: string | null; venueIds: string[] | null };
const numeric = (value: unknown) => String(value ?? '0');
export class ReportingService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
  ) {}
  parse(raw: unknown) {
    const input = reportFilters.parse(raw),
      length = Date.parse(input.to) - Date.parse(input.from);
    if (length <= 0 || length > 366 * 86400_000)
      throw new ApiError('INVALID_INTERVAL', 'Choose a reporting window of at most 366 days.', 400);
    return input;
  }
  private async scope(
    actor: Reporter,
    organizationId: string | null,
    filters: Filters,
    tx: PoolClient,
  ): Promise<Scope> {
    let venueIds: string[] | null = null;
    if (organizationId) venueIds = await this.organizations.scope(actor, organizationId, 'finance.read', tx);
    else await this.organizations.platformAny(actor, ['admin', 'finance'], tx);
    if (filters.venueId) {
      if (venueIds && !venueIds.includes(filters.venueId))
        throw new ApiError('FORBIDDEN', 'Venue is outside your reporting scope.', 403);
      const venue = await tx.query(
        'SELECT id FROM venues WHERE id=$1 AND ($2::uuid IS NULL OR organization_id=$2)',
        [filters.venueId, organizationId],
      );
      if (!venue.rowCount) throw new ApiError('NOT_FOUND', 'Venue not found in this reporting scope.', 404);
      venueIds = [filters.venueId];
    }
    if (filters.occurrenceId) {
      const event = (
        await tx.query(
          'SELECT e.venue_id FROM occurrences c JOIN events e ON e.id=c.event_id JOIN venues v ON v.id=e.venue_id WHERE c.id=$1 AND ($2::uuid IS NULL OR v.organization_id=$2) AND ($3::text[] IS NULL OR v.id=ANY($3))',
          [filters.occurrenceId, organizationId, venueIds],
        )
      ).rows[0];
      if (!event) throw new ApiError('NOT_FOUND', 'Event not found in this reporting scope.', 404);
    }
    return { organizationId, venueIds };
  }
  async report(actor: Reporter, organizationId: string | null, raw: unknown) {
    const filters = this.parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return {
        data: await this.calculate(tx, await this.scope(actor, organizationId, filters, tx), filters),
      };
    });
  }
  private async calculate(tx: PoolClient, scope: Scope, filters: Filters) {
    const params = [
      scope.organizationId,
      scope.venueIds,
      filters.occurrenceId ?? null,
      filters.currency ?? null,
      filters.from,
      filters.to,
      filters.timezone,
    ];
    const orders = `SELECT o.* FROM orders o WHERE ($1::uuid IS NULL OR o.organization_id=$1) AND ($2::text[] IS NULL OR o.venue_id=ANY($2)) AND ($3::uuid IS NULL OR o.occurrence_id=$3) AND ($4::text IS NULL OR o.currency=$4)`;
    const occurrence = `SELECT c.*,e.venue_id,e.title FROM occurrences c JOIN events e ON e.id=c.event_id JOIN venues v ON v.id=e.venue_id WHERE ($1::uuid IS NULL OR v.organization_id=$1) AND ($2::text[] IS NULL OR v.id=ANY($2)) AND ($3::uuid IS NULL OR c.id=$3) AND ($4::text IS NULL OR c.currency=$4)`;
    // All panels use one repeatable-read snapshot; immutable postings are the financial source of truth.
    const financial = (
      await tx.query(
        `WITH scoped AS (${orders}), activity AS (
      SELECT j.*,p.account,p.amount_minor FROM scoped o JOIN ledger_journals j ON j.order_id=o.id JOIN ledger_postings p ON p.journal_id=j.id
      WHERE j.book='commerce' AND j.created_at>=$5 AND j.created_at<$6)
      SELECT currency,(created_at AT TIME ZONE $7)::date::text AS day,
      coalesce(sum(amount_minor) FILTER(WHERE account='provider-collected' AND reference LIKE 'sale:%'),0)::text AS "grossMinor",
      coalesce(-sum(amount_minor) FILTER(WHERE account='provider-collected' AND reference LIKE 'refund:%'),0)::text AS "refundMinor",
      coalesce(-sum(amount_minor) FILTER(WHERE account='platform-commission'),0)::text AS "commissionMinor",
      coalesce(sum(amount_minor) FILTER(WHERE account='seller-dispute-loss'),0)::text AS "chargebackLossMinor",
      coalesce(sum(amount_minor) FILTER(WHERE account='provider-collected'),0)::text AS "netOnlineMinor",
      (coalesce(-sum(amount_minor) FILTER(WHERE account='seller-gross'),0)-coalesce(sum(amount_minor) FILTER(WHERE account='seller-dispute-loss'),0))::text AS "sellerNetBeforeProviderFeesMinor",
      coalesce(sum(amount_minor) FILTER(WHERE account IN ('seller-cash','seller-external-card')),0)::text AS "doorCollectedMinor",
      coalesce(sum(amount_minor) FILTER(WHERE account='seller-receivable'),0)::text AS "receivableMovementMinor"
      FROM activity GROUP BY currency,day ORDER BY day,currency`,
        params,
      )
    ).rows;
    const cohort = (
      await tx.query(
        `WITH scoped AS (${orders}) SELECT currency,
      count(*)::text AS "checkoutsStarted",count(*) FILTER(WHERE paid_at IS NOT NULL)::text AS "checkoutsPaid",
      count(DISTINCT user_id) FILTER(WHERE paid_at IS NOT NULL)::text AS "buyers",
      count(DISTINCT user_id) FILTER(WHERE paid_at IS NOT NULL AND EXISTS(SELECT 1 FROM scoped previous WHERE previous.user_id=o.user_id AND previous.paid_at<o.created_at AND previous.payment_role<>'group-reservation'))::text AS "repeatBuyers"
      FROM scoped o WHERE payment_role<>'group-reservation' AND created_at>=$5 AND created_at<$6 GROUP BY currency ORDER BY currency`,
        params.slice(0, 6),
      )
    ).rows;
    const admissions = (
      await tx.query(
        `WITH scoped AS (${occurrence}) SELECT count(*) FILTER(WHERE s.kind='admission' AND s.outcome IN ('accepted','manual-accepted'))::text AS "admissions",count(*) FILTER(WHERE s.kind='drink' AND s.outcome='accepted')::text AS "drinks",count(*) FILTER(WHERE s.outcome NOT IN ('accepted','manual-accepted'))::text AS "rejectedScans" FROM admission_scans s JOIN scoped c ON c.id=s.occurrence_id WHERE s.created_at>=$5 AND s.created_at<$6`,
        params.slice(0, 6),
      )
    ).rows[0]!;
    const events = (
      await tx.query(
        `WITH scoped AS (${occurrence}) SELECT c.id,c.title,c.venue_id AS "venueId",c.starts_at AS "startsAt",c.timezone,c.currency,c.status,c.capacity,
      (SELECT count(*)::text FROM tickets t JOIN orders o ON o.id=t.order_id WHERE t.occurrence_id=c.id AND t.status='valid' AND o.paid_at IS NOT NULL AND o.status IN ('paid','partially-refunded') AND NOT o.dispute_open AND NOT o.cancellation_requested) AS "activeAdmissions",
      (SELECT count(*)::text FROM tickets t WHERE t.occurrence_id=c.id AND t.admitted_at IS NOT NULL) AS "admitted",
      (SELECT count(*)::text FROM table_reservations r JOIN orders o ON o.id=r.order_id WHERE o.occurrence_id=c.id AND r.status IN ('confirmed','no-show')) AS "confirmedTables",
      (SELECT count(*)::text FROM table_reservations r JOIN orders o ON o.id=r.order_id WHERE o.occurrence_id=c.id AND r.status='no-show') AS "noShowTables"
      FROM scoped c WHERE c.starts_at>=$5 AND c.starts_at<$6 ORDER BY c.starts_at,c.id LIMIT 5001`,
        params.slice(0, 6),
      )
    ).rows;
    if (events.length > 5000)
      throw new ApiError('REPORT_TOO_LARGE', 'Choose a narrower window or venue filter.', 400);
    const reconciliation = (
      await tx.query(
        `WITH scoped AS (${orders}), amounts AS (
      SELECT currency,coalesce(sum(total_minor) FILTER(WHERE paid_at IS NOT NULL AND payment_role<>'group-reservation'),0) AS captured FROM scoped GROUP BY currency),
      posted AS (SELECT j.currency,coalesce(sum(p.amount_minor) FILTER(WHERE j.reference LIKE 'sale:%'),0) AS captured,coalesce(-sum(p.amount_minor) FILTER(WHERE j.reference LIKE 'refund:%'),0) AS refunded FROM scoped o JOIN ledger_journals j ON j.order_id=o.id JOIN ledger_postings p ON p.journal_id=j.id WHERE j.book='commerce' AND p.account='provider-collected' GROUP BY j.currency)
      SELECT a.currency,(a.captured-coalesce(p.captured,0))::text AS "captureDifferenceMinor",
      ((SELECT coalesce(sum(r.amount_minor),0) FROM refunds r JOIN scoped o ON o.id=r.order_id WHERE r.status='succeeded' AND o.currency=a.currency)-coalesce(p.refunded,0))::text AS "refundDifferenceMinor",
      (SELECT count(*)::text FROM external_refunds r JOIN scoped o ON o.id=r.order_id WHERE o.currency=a.currency AND r.allocated_refund_id IS NULL AND r.status IN ('pending','succeeded')) AS "unallocatedProviderRefunds",
      (SELECT count(*)::text FROM scoped o WHERE o.currency=a.currency AND o.status='review') AS "ordersUnderReview",
      (SELECT coalesce(sum(p.amount_minor),0)::text FROM ledger_journals j JOIN ledger_postings p ON p.journal_id=j.id JOIN scoped o ON o.id=j.order_id WHERE j.book='commerce' AND j.currency=a.currency AND p.account='seller-receivable') AS "currentTableReceivableMinor"
      FROM amounts a LEFT JOIN posted p ON p.currency=a.currency ORDER BY a.currency`,
        params.slice(0, 4),
      )
    ).rows;
    // Provider balances are account-wide. Never imply they belong to one venue or event filter.
    const provider =
      scope.venueIds === null && !filters.occurrenceId
        ? {
            activity: (
              await tx.query(
                `SELECT b.currency,sum(b.amount_minor)::text AS "amountMinor",sum(b.fee_minor)::text AS "feeMinor",sum(b.net_minor)::text AS "netMinor" FROM provider_balance_transactions b JOIN seller_accounts a ON a.account_id=b.account_id WHERE ($1::uuid IS NULL OR a.organization_id=$1) AND ($2::text IS NULL OR b.currency=$2) AND b.created_at>=$3 AND b.created_at<$4 GROUP BY b.currency ORDER BY b.currency`,
                [scope.organizationId, filters.currency ?? null, filters.from, filters.to],
              )
            ).rows,
            freshness: (
              await tx.query(
                `SELECT a.organization_id AS "organizationId",max(r.completed_at) FILTER(WHERE r.status='matched') AS "lastMatchedAt",max(r.created_at) AS "lastAttemptAt",(SELECT latest.status FROM reconciliation_runs latest WHERE latest.account_id=a.account_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1) AS "latestStatus" FROM seller_accounts a LEFT JOIN reconciliation_runs r ON r.account_id=a.account_id WHERE ($1::uuid IS NULL OR a.organization_id=$1) GROUP BY a.organization_id,a.account_id ORDER BY a.organization_id`,
                [scope.organizationId],
              )
            ).rows,
            payouts: (
              await tx.query(
                `SELECT p.currency,p.status,count(*)::text AS count,sum(p.amount_minor)::text AS "amountMinor" FROM provider_payouts p JOIN seller_accounts a ON a.account_id=p.account_id WHERE ($1::uuid IS NULL OR a.organization_id=$1) AND ($2::text IS NULL OR p.currency=$2) AND p.arrival_date>=$3 AND p.arrival_date<$4 GROUP BY p.currency,p.status ORDER BY p.currency,p.status`,
                [scope.organizationId, filters.currency ?? null, filters.from, filters.to],
              )
            ).rows,
          }
        : null;
    return {
      version: 1,
      generatedAt: (await tx.query('SELECT transaction_timestamp() AS time')).rows[0]!.time.toISOString(),
      filters,
      financial,
      cohort,
      admissions,
      events,
      reconciliation,
      provider,
    };
  }
  async requestExport(actor: Principal, organizationId: string | null, raw: unknown, key: string) {
    const filters = this.parse(raw);
    return this.db.transaction(async (tx) => {
      const scope = await this.scope(actor, organizationId, filters, tx);
      return idempotent(tx, actor.userId, 'report.export', key, { organizationId, filters }, async () => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,83))', [actor.userId]);
        const count = (
          await tx.query(
            "SELECT count(*)::int AS value FROM report_exports WHERE requested_by=$1 AND created_at>now()-interval '1 hour'",
            [actor.userId],
          )
        ).rows[0]!.value;
        if (count >= 10) throw new ApiError('EXPORT_LIMIT', 'Wait before requesting another export.', 429);
        const id = randomUUID();
        await tx.query(
          'INSERT INTO report_exports(id,requested_by,organization_id,filters,venue_ids) VALUES($1,$2,$3,$4,$5)',
          [id, actor.userId, organizationId, JSON.stringify(filters), scope.venueIds],
        );
        await enqueue(tx, 'report.generate', id, { reportId: id });
        await audit(tx, actor.userId, 'report.request', 'report', id, 'Requested aggregate report export', {
          organizationId,
          ...filters,
        });
        return { data: { id, status: 'queued' } };
      });
    });
  }
  private assertExportScope(allowed: Scope, stored: string[] | null) {
    if (allowed.venueIds && (!stored || stored.some((id) => !allowed.venueIds!.includes(id))))
      throw new ApiError('FORBIDDEN', 'Your reporting scope changed. Request a new report.', 403);
  }
  async generate(reportId: string) {
    await this.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const row = (await tx.query('SELECT * FROM report_exports WHERE id=$1 FOR UPDATE', [reportId])).rows[0];
      if (!row || row.status !== 'queued') return;
      if (row.expires_at.getTime() <= Date.now()) {
        await tx.query("UPDATE report_exports SET status='expired',result_encrypted=NULL WHERE id=$1", [
          reportId,
        ]);
        return;
      }
      const actor = (
        await tx.query('SELECT id AS "userId",kind FROM users WHERE id=$1 AND status=\'active\'', [
          row.requested_by,
        ])
      ).rows[0] as Reporter | undefined;
      try {
        if (!actor) throw new ApiError('FORBIDDEN', 'Account is no longer active.', 403);
        const filters = this.parse(row.filters),
          allowed = await this.scope(actor, row.organization_id, filters, tx);
        this.assertExportScope(allowed, row.venue_ids);
        const result = await this.calculate(
          tx,
          { organizationId: row.organization_id, venueIds: row.venue_ids },
          filters,
        );
        await tx.query(
          "UPDATE report_exports SET status='completed',completed_at=now(),result_encrypted=$1 WHERE id=$2",
          [encrypt(result, this.db.config.encryptionKeys), reportId],
        );
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          !['FORBIDDEN', 'NOT_FOUND', 'REPORT_TOO_LARGE'].includes(error.code)
        )
          throw error;
        await tx.query(
          'UPDATE report_exports SET status=$1,error_code=$2,result_encrypted=NULL WHERE id=$3',
          [error.code === 'REPORT_TOO_LARGE' ? 'failed' : 'denied', error.code, reportId],
        );
      }
    });
  }
  async export(actor: Principal, id: string) {
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          "SELECT r.*,j.status AS job_status FROM report_exports r LEFT JOIN outbox_jobs j ON j.topic='report.generate' AND j.dedupe_key=r.id::text WHERE r.id=$1 AND r.requested_by=$2",
          [id, actor.userId],
        )
      ).rows[0];
      if (!row) throw new ApiError('NOT_FOUND', 'Export not found.', 404);
      const allowed = await this.scope(actor, row.organization_id, this.parse(row.filters), tx);
      this.assertExportScope(allowed, row.venue_ids);
      const expired = row.expires_at.getTime() <= Date.now();
      return {
        data: {
          id,
          status: expired
            ? 'expired'
            : row.status === 'queued' && row.job_status === 'dead'
              ? 'failed'
              : row.status,
          errorCode: row.error_code ?? (row.job_status === 'dead' ? 'EXPORT_FAILED' : null),
          expiresAt: row.expires_at.toISOString(),
          report:
            !expired && row.status === 'completed'
              ? (decrypt(row.result_encrypted, this.db.config.encryptionKeys) as Awaited<
                  ReturnType<ReportingService['calculate']>
                >)
              : null,
        },
      };
    });
  }
  async csv(actor: Principal, id: string) {
    const result = await this.export(actor, id),
      report = result.data.report;
    if (!report) throw new ApiError('EXPORT_NOT_READY', 'The export is not available.', 409);
    const cell = (v: unknown) => {
      let text = String(v ?? '');
      if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows: unknown[][] = [
      ['section', 'day_or_event', 'currency', 'metric', 'value'],
      ['metadata', '', '', 'generated_at', report.generatedAt],
      ['metadata', '', '', 'from', report.filters.from],
      ['metadata', '', '', 'to_exclusive', report.filters.to],
      ['metadata', '', '', 'timezone', report.filters.timezone],
    ];
    for (const name of ['financial', 'cohort', 'reconciliation'] as const)
      for (const row of report[name])
        for (const [metric, value] of Object.entries(row))
          if (!['currency', 'day'].includes(metric))
            rows.push([name, row.day ?? '', row.currency, metric, numeric(value)]);
    for (const [metric, value] of Object.entries(report.admissions))
      rows.push(['scans', '', '', metric, value]);
    for (const event of report.events)
      for (const metric of [
        'title',
        'startsAt',
        'timezone',
        'venueId',
        'status',
        'capacity',
        'activeAdmissions',
        'admitted',
        'confirmedTables',
        'noShowTables',
      ])
        rows.push(['events', event.id, event.currency, metric, event[metric]]);
    if (report.provider)
      for (const row of report.provider.activity)
        for (const metric of ['amountMinor', 'feeMinor', 'netMinor'])
          rows.push(['provider', '', '' + row.currency, metric, row[metric]]);
    if (report.provider) {
      for (const row of report.provider.freshness)
        for (const metric of ['lastMatchedAt', 'lastAttemptAt', 'latestStatus'])
          rows.push(['provider_freshness', row.organizationId, '', metric, row[metric]]);
      for (const row of report.provider.payouts)
        for (const metric of ['count', 'amountMinor'])
          rows.push(['payouts', row.status, row.currency, metric, row[metric]]);
    }
    await this.db.transaction((tx) =>
      audit(tx, actor.userId, 'report.download', 'report', id, 'Downloaded aggregate report export'),
    );
    return rows.map((row) => row.map(cell).join(',')).join('\r\n');
  }
  async maintenance() {
    await this.db.query(
      "UPDATE report_exports SET status='expired',result_encrypted=NULL WHERE expires_at<=now() AND status<>'expired'",
    );
  }
}
