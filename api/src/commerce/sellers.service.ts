import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../platform/database';
import type { Principal } from '../identity/identity.service';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import { ApiError } from '../platform/http';
import type { PaymentProvider, Seller } from './provider';

export class SellersService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
    readonly provider: PaymentProvider,
  ) {}
  async policy(actor: Principal, organizationId: string, raw: unknown) {
    await this.organizations.platform(actor);
    const input = z
      .object({
        commissionBps: z.number().int().min(0).max(10000),
        refundCutoffHours: z.number().int().min(0).max(8760),
        refundCommission: z.boolean(),
        terms: z.string().min(40).max(20000),
        taxRegistration: z.string().min(3).max(200),
        processingFeeBearer: z.literal('seller'),
        payoutModel: z.literal('stripe-managed'),
        reason: z.string().min(10).max(1000),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const org = await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [organizationId]);
      if (!org.rowCount) throw new ApiError('NOT_FOUND', 'Organization not found.', 404);
      const version =
        1 +
        Number(
          (
            await tx.query(
              'SELECT coalesce(max(version),0) AS version FROM commercial_policies WHERE organization_id=$1',
              [organizationId],
            )
          ).rows[0].version,
        );
      const id = randomUUID();
      await tx.query(
        'INSERT INTO commercial_policies(id,organization_id,version,commission_bps,refund_cutoff_hours,refund_commission,terms,tax_registration,processing_fee_bearer,payout_model,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          id,
          organizationId,
          version,
          input.commissionBps,
          input.refundCutoffHours,
          input.refundCommission,
          input.terms,
          input.taxRegistration,
          input.processingFeeBearer,
          input.payoutModel,
          actor.userId,
        ],
      );
      await audit(tx, actor.userId, 'commerce.policy', 'organization', organizationId, input.reason, {
        policyId: id,
        version,
      });
      return { data: { id, version } };
    });
  }
  async accept(actor: Principal, organizationId: string, policyId: string) {
    return this.db.transaction(async (tx) => {
      await this.organizations.authorize(actor, organizationId, 'members.manage', undefined, false, tx);
      const current = (
        await tx.query(
          'SELECT id FROM commercial_policies WHERE organization_id=$1 ORDER BY version DESC LIMIT 1',
          [organizationId],
        )
      ).rows[0];
      if (current?.id !== policyId)
        throw new ApiError('POLICY_CHANGED', 'Read and accept the latest commercial policy.', 409);
      await tx.query(
        'INSERT INTO policy_acceptances(policy_id,actor_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [policyId, actor.userId],
      );
      await audit(
        tx,
        actor.userId,
        'commerce.policy.accept',
        'organization',
        organizationId,
        'Owner accepted the displayed commercial terms',
        { policyId },
      );
      return { data: { accepted: true } };
    });
  }
  async status(actor: Principal, organizationId: string) {
    await this.organizations.authorize(actor, organizationId, 'members.manage');
    return {
      data: {
        account:
          (
            await this.db.query(
              'SELECT account_id,charges_enabled,payouts_enabled,configuration_valid,livemode,requirements,status,synced_at FROM seller_accounts WHERE organization_id=$1',
              [organizationId],
            )
          ).rows[0] ?? null,
        policy:
          (
            await this.db.query(
              'SELECT p.*,a.accepted_at FROM commercial_policies p LEFT JOIN policy_acceptances a ON a.policy_id=p.id WHERE p.organization_id=$1 ORDER BY p.version DESC LIMIT 1',
              [organizationId],
            )
          ).rows[0] ?? null,
      },
    };
  }
  async sync(id: string) {
    const value = await this.provider.seller(id);
    await this.save(value);
    return value;
  }
  private async save(value: Seller) {
    if (value.livemode !== (this.db.config.STRIPE_MODE === 'live'))
      throw new Error('Stripe account environment mismatch.');
    await this.db.query(
      'UPDATE seller_accounts SET charges_enabled=$1,payouts_enabled=$2,configuration_valid=$3,livemode=$4,requirements=$5,synced_at=now(),status=$6 WHERE account_id=$7',
      [
        value.charges,
        value.payouts,
        value.valid,
        value.livemode,
        JSON.stringify(value.requirements),
        value.charges && value.payouts && value.valid ? 'ready' : 'restricted',
        value.id,
      ],
    );
  }
  async onboard(actor: Principal, organizationId: string) {
    if (this.db.config.STRIPE_MODE === 'disabled')
      throw new ApiError('PAYMENTS_NOT_CONFIGURED', 'Stripe is not connected yet.', 503);
    const row = await this.db.transaction(async (tx) => {
      await this.organizations.authorize(actor, organizationId, 'members.manage', undefined, false, tx);
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [organizationId]);
      const org = (
        await tx.query('SELECT name,country_code FROM organizations WHERE id=$1', [organizationId])
      ).rows[0];
      await tx.query(
        'INSERT INTO seller_accounts(organization_id,creation_key,creation_input) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [
          organizationId,
          randomUUID(),
          JSON.stringify({ organizationId, name: org.name, country: org.country_code, email: actor.email }),
        ],
      );
      return (await tx.query('SELECT * FROM seller_accounts WHERE organization_id=$1', [organizationId]))
        .rows[0];
    });
    let accountId = row.account_id as string | null;
    if (!accountId) {
      if (Date.now() - row.creation_started_at.getTime() > 23 * 3600_000) {
        await this.db.query("UPDATE seller_accounts SET status='review' WHERE organization_id=$1", [
          organizationId,
        ]);
        throw new ApiError(
          'PROVIDER_REVIEW_REQUIRED',
          'Account creation needs reconciliation before retry.',
          409,
        );
      }
      const account = await this.provider.createSeller(row.creation_input, `seller-${row.creation_key}`);
      accountId = account.id;
      await this.db.query(
        'UPDATE seller_accounts SET account_id=$1 WHERE organization_id=$2 AND account_id IS NULL',
        [accountId, organizationId],
      );
      await this.save(account);
    } else await this.sync(accountId);
    // Recheck current permissions after external work before exposing a sensitive single-use onboarding URL.
    await this.organizations.authorize(actor, organizationId, 'members.manage');
    return { data: await this.provider.onboarding(accountId, this.db.config.STRIPE_ONBOARDING_ORIGIN!) };
  }
  async refresh(actor: Principal, organizationId: string) {
    await this.organizations.authorize(actor, organizationId, 'members.manage');
    const account = (
      await this.db.query('SELECT account_id FROM seller_accounts WHERE organization_id=$1', [organizationId])
    ).rows[0];
    if (!account?.account_id) throw new ApiError('NOT_FOUND', 'Connect onboarding has not started.', 404);
    await this.sync(account.account_id);
    return this.status(actor, organizationId);
  }
  async market(actor: Principal, id: string, raw: unknown) {
    await this.organizations.platform(actor);
    const input = z
      .object({
        enabled: z.boolean(),
        expectedVersion: z.number().int().positive(),
        reason: z.string().min(10).max(1000),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const market = (
        await tx.query(
          'SELECT d.*,r.expires_at,r.seller_countries,r.country_code AS reviewed_country,r.currency AS reviewed_currency,r.timezone AS reviewed_timezone FROM destinations d LEFT JOIN market_reviews r ON r.id=d.market_review_id WHERE d.id=$1 FOR UPDATE OF d',
          [id],
        )
      ).rows[0];
      if (!market || market.version !== input.expectedVersion)
        throw new ApiError('VERSION_CONFLICT', 'Destination changed.', 409);
      if (input.enabled) {
        if (
          this.db.config.STRIPE_MODE === 'disabled' ||
          !market.published ||
          !market.expires_at ||
          market.expires_at.getTime() <= Date.now() ||
          market.country_code !== market.reviewed_country ||
          market.currency !== market.reviewed_currency ||
          market.timezone !== market.reviewed_timezone
        )
          throw new ApiError(
            'MARKET_NOT_READY',
            'A current market review and payment configuration are required.',
            409,
          );
        const ready = (
          await tx.query(
            `SELECT 1 FROM venues v JOIN organizations o ON o.id=v.organization_id JOIN seller_accounts a ON a.organization_id=o.id WHERE v.destination_id=$1 AND v.status='published' AND v.commercial_mode='native' AND NOT v.demo AND o.status='approved' AND o.country_code=ANY($2::text[]) AND a.status='ready' AND a.charges_enabled AND a.payouts_enabled AND a.configuration_valid AND a.livemode=$3 AND a.synced_at>now()-interval '15 minutes' AND EXISTS(SELECT 1 FROM policy_acceptances pa WHERE pa.policy_id=(SELECT p.id FROM commercial_policies p WHERE p.organization_id=o.id ORDER BY p.version DESC LIMIT 1)) LIMIT 1`,
            [id, market.seller_countries, this.db.config.STRIPE_MODE === 'live'],
          )
        ).rowCount;
        if (!ready)
          throw new ApiError(
            'MARKET_NOT_READY',
            'At least one published eligible seller must complete payment onboarding and accept current terms.',
            409,
          );
      }
      const result = await tx.query(
        'UPDATE destinations SET native_sales_enabled=$1,version=version+1 WHERE id=$2 RETURNING id,native_sales_enabled,version',
        [input.enabled, id],
      );
      if (!result.rowCount) throw new ApiError('NOT_FOUND', 'Destination not found.', 404);
      await audit(tx, actor.userId, 'commerce.market', 'destination', id, input.reason, {
        enabled: input.enabled,
      });
      return { data: result.rows[0] };
    });
  }
}
