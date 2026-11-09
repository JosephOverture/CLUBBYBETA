import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import type { Principal } from '../identity/identity.service';
import { notifyBuyer } from '../commerce/core';
const reason = z.string().trim().min(10).max(1000),
  version = z.number().int().positive();
export const featureSettings = z
  .object({
    groupCreation: z.boolean(),
    ticketTransfers: z.boolean(),
    walletCreation: z.boolean(),
    chatMessages: z.boolean(),
  })
  .strict();
export const marketChecks = z
  .object({
    catalogueReviewed: z.literal(true),
    providerSupported: z.literal(true),
    refundAndTaxTermsReviewed: z.literal(true),
    payoutsReviewed: z.literal(true),
    localSupportReady: z.literal(true),
    privacyReviewed: z.literal(true),
  })
  .strict();
export class AdministrationService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
  ) {}
  async users(actor: Principal, raw: unknown) {
    await this.organizations.platform(actor);
    const input = z
      .object({ query: z.string().trim().min(3).max(254), before: z.string().uuid().optional() })
      .strict()
      .parse(raw);
    // Exact verified-email/ID lookup avoids broad customer data export from an administration search.
    return {
      data: (
        await this.db.query(
          'SELECT id,email,display_name AS "displayName",kind,status,version,created_at AS "createdAt" FROM users WHERE (email=$1 OR id::text=$1) AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT 50',
          [input.query.toLowerCase(), input.before ?? null],
        )
      ).rows,
    };
  }
  async userStatus(actor: Principal, id: string, raw: unknown) {
    await this.organizations.platform(actor);
    const input = z
      .object({ status: z.enum(['active', 'suspended']), expectedVersion: version, reason })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(42819209)');
      await this.organizations.platformAny(actor, ['admin'], tx);
      const user = (await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!user) throw new ApiError('NOT_FOUND', 'User not found.', 404);
      if (user.status === 'deleted' || user.status === 'deletion-pending')
        throw new ApiError('PRIVACY_WORKFLOW', 'Use the privacy workflow for this account.', 409);
      if (user.version !== input.expectedVersion)
        throw new ApiError('VERSION_CONFLICT', 'Account changed.', 409);
      if (id === actor.userId && input.status === 'suspended')
        throw new ApiError('SELF_SUSPENSION', 'Another administrator must review your own suspension.', 409);
      if (
        input.status === 'suspended' &&
        (
          await tx.query(
            "SELECT 1 FROM platform_grants WHERE user_id=$1 AND role='admin' AND revoked_at IS NULL",
            [id],
          )
        ).rowCount &&
        !(
          await tx.query(
            "SELECT 1 FROM platform_grants g JOIN users u ON u.id=g.user_id WHERE g.role='admin' AND g.revoked_at IS NULL AND u.status='active' AND u.id<>$1",
            [id],
          )
        ).rowCount
      )
        throw new ApiError('LAST_ADMIN', 'Keep at least one active administrator.', 409);
      await tx.query('UPDATE users SET status=$1,version=version+1,updated_at=now() WHERE id=$2', [
        input.status,
        id,
      ]);
      if (input.status === 'suspended') {
        await tx.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
        await tx.query(
          'UPDATE staff_invitations SET revoked_at=now() WHERE inviter_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL',
          [id],
        );
        await tx.query(
          'UPDATE group_invitations SET revoked_at=now() WHERE inviter_id=$1 AND used_at IS NULL AND revoked_at IS NULL',
          [id],
        );
        await tx.query(
          "UPDATE ticket_transfers SET status='revoked' WHERE sender_id=$1 AND status='pending'",
          [id],
        );
        await tx.query(
          "UPDATE group_owner_transfers SET status='revoked' WHERE (from_user_id=$1 OR to_user_id=$1) AND status='pending'",
          [id],
        );
        await tx.query(
          "UPDATE organization_owner_transfers SET state='revoked' WHERE (from_user_id=$1 OR to_user_id=$1 OR created_by=$1) AND state='pending'",
          [id],
        );
      }
      await audit(tx, actor.userId, 'user.status', 'user', id, input.reason, {
        status: input.status,
        version: user.version + 1,
      });
      return { data: { id, status: input.status, version: user.version + 1 } };
    });
  }
  async grants(actor: Principal, userId: string) {
    await this.organizations.platform(actor);
    return {
      data: (
        await this.db.query(
          'SELECT role,version,revoked_at AS "revokedAt" FROM platform_grants WHERE user_id=$1 ORDER BY role',
          [userId],
        )
      ).rows,
    };
  }
  async grant(actor: Principal, userId: string, raw: unknown) {
    await this.organizations.platform(actor);
    const input = z
      .object({
        role: z.enum(['admin', 'support', 'finance']),
        active: z.boolean(),
        expectedVersion: z.number().int().min(0),
        reason,
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(42819209)');
      await this.organizations.platformAny(actor, ['admin'], tx);
      const user = (
        await tx.query(
          "SELECT id FROM users WHERE id=$1 AND status='active' AND kind='registered' FOR SHARE",
          [userId],
        )
      ).rows[0];
      if (!user) throw new ApiError('NOT_FOUND', 'Active verified account not found.', 404);
      const existing = (
        await tx.query('SELECT * FROM platform_grants WHERE user_id=$1 AND role=$2 FOR UPDATE', [
          userId,
          input.role,
        ])
      ).rows[0];
      if ((existing?.version ?? 0) !== input.expectedVersion)
        throw new ApiError('VERSION_CONFLICT', 'Platform access changed.', 409);
      if (
        !input.active &&
        input.role === 'admin' &&
        existing &&
        !existing.revoked_at &&
        !(
          await tx.query(
            "SELECT 1 FROM platform_grants g JOIN users u ON u.id=g.user_id WHERE g.role='admin' AND g.revoked_at IS NULL AND u.status='active' AND g.user_id<>$1",
            [userId],
          )
        ).rowCount
      )
        throw new ApiError('LAST_ADMIN', 'Keep at least one active administrator.', 409);
      const row = (
        await tx.query(
          'INSERT INTO platform_grants(user_id,role,revoked_at) VALUES($1,$2,CASE WHEN $3 THEN NULL ELSE now() END) ON CONFLICT(user_id,role) DO UPDATE SET revoked_at=EXCLUDED.revoked_at,version=platform_grants.version+1 RETURNING role,version,revoked_at',
          [userId, input.role, input.active],
        )
      ).rows[0];
      await audit(tx, actor.userId, 'platform.grant', 'user', userId, input.reason, {
        role: input.role,
        active: input.active,
        version: row.version,
      });
      return { data: row };
    });
  }
  async markets(actor: Principal) {
    await this.organizations.platform(actor);
    return {
      data: (
        await this.db.query(
          'SELECT d.*,r.version AS review_version,r.checks,r.evidence,r.expires_at,r.seller_countries FROM destinations d LEFT JOIN market_reviews r ON r.id=d.market_review_id ORDER BY d.name',
        )
      ).rows,
    };
  }
  async organization(actor: Principal, id: string) {
    await this.organizations.platform(actor);
    const org = (
      await this.db.query(
        'SELECT id,name,status,version,application,country_code FROM organizations WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!org) throw new ApiError('NOT_FOUND', 'Organization not found.', 404);
    return {
      data: {
        ...org,
        members: (
          await this.db.query(
            'SELECT m.id,m.user_id,m.role,m.status,u.email,u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE organization_id=$1 ORDER BY m.created_at',
            [id],
          )
        ).rows,
        venues: (
          await this.db.query(
            'SELECT id,name,status,version,commercial_mode,external_url FROM venues WHERE organization_id=$1 ORDER BY name',
            [id],
          )
        ).rows,
        policy:
          (
            await this.db.query(
              'SELECT * FROM commercial_policies WHERE organization_id=$1 ORDER BY version DESC LIMIT 1',
              [id],
            )
          ).rows[0] ?? null,
        ownershipRequests: (
          await this.db.query(
            "SELECT id,from_user_id,to_user_id,expires_at FROM organization_owner_transfers WHERE organization_id=$1 AND state='pending' AND expires_at>now() ORDER BY created_at",
            [id],
          )
        ).rows,
      },
    };
  }
  async revokeOwnership(actor: Principal, id: string, raw: unknown) {
    const input = z.object({ reason }).strict().parse(raw);
    return this.db.transaction(async (tx) => {
      await this.organizations.platformAny(actor, ['admin'], tx);
      const located = (
        await tx.query('SELECT organization_id FROM organization_owner_transfers WHERE id=$1', [id])
      ).rows[0];
      if (!located) throw new ApiError('NOT_FOUND', 'Ownership request not found.', 404);
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [located.organization_id]);
      const transfer = (
        await tx.query('SELECT state FROM organization_owner_transfers WHERE id=$1 FOR UPDATE', [id])
      ).rows[0]!;
      if (transfer.state === 'accepted')
        throw new ApiError('ALREADY_ACCEPTED', 'Ownership was already accepted. Review a new transfer.', 409);
      await tx.query("UPDATE organization_owner_transfers SET state='revoked' WHERE id=$1", [id]);
      await audit(
        tx,
        actor.userId,
        'organization.owner-revoke',
        'organization',
        located.organization_id,
        input.reason,
        { transferId: id },
      );
      return { data: { revoked: true } };
    });
  }
  async reviewMarket(actor: Principal, id: string, raw: unknown) {
    await this.organizations.platform(actor);
    const input = z
      .object({
        expectedVersion: version,
        sellerCountries: z
          .array(z.string().regex(/^[A-Z]{2}$/))
          .min(1)
          .max(50),
        checks: marketChecks,
        evidence: z.string().trim().min(40).max(5000),
        expiresAt: z.iso.datetime({ offset: true }),
        reason,
      })
      .strict()
      .parse(raw);
    if (
      Date.parse(input.expiresAt) <= Date.now() ||
      Date.parse(input.expiresAt) > Date.now() + 366 * 86400_000
    )
      throw new ApiError('REVIEW_EXPIRY', 'Market review must expire within the next year.', 400);
    return this.db.transaction(async (tx) => {
      const destination = (await tx.query('SELECT * FROM destinations WHERE id=$1 FOR UPDATE', [id])).rows[0];
      await this.organizations.platformAny(actor, ['admin'], tx);
      if (!destination || destination.version !== input.expectedVersion)
        throw new ApiError('VERSION_CONFLICT', 'Destination changed.', 409);
      if (!destination.published)
        throw new ApiError(
          'MARKET_NOT_READY',
          'Publish the reviewed destination before reviewing commerce.',
          409,
        );
      const next = (
          await tx.query(
            'SELECT coalesce(max(version),0)+1 AS version FROM market_reviews WHERE destination_id=$1',
            [id],
          )
        ).rows[0]!.version,
        reviewId = randomUUID();
      await tx.query(
        'INSERT INTO market_reviews(id,destination_id,version,country_code,currency,timezone,seller_countries,checks,evidence,reviewed_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          reviewId,
          id,
          next,
          destination.country_code,
          destination.currency,
          destination.timezone,
          [...new Set(input.sellerCountries)],
          JSON.stringify(input.checks),
          input.evidence,
          actor.userId,
          input.expiresAt,
        ],
      );
      await tx.query(
        'UPDATE destinations SET market_review_id=$1,native_sales_enabled=false,version=version+1 WHERE id=$2',
        [reviewId, id],
      );
      await audit(tx, actor.userId, 'market.review', 'destination', id, input.reason, {
        reviewId,
        expiresAt: input.expiresAt,
      });
      return { data: { id, reviewId, version: destination.version + 1, nativeSalesEnabled: false } };
    });
  }
  async prepareOwnerTransfer(actor: Principal, id: string, raw: unknown) {
    await this.organizations.platform(actor);
    const input = z
      .object({
        fromUserId: z.string().uuid(),
        toUserId: z.string().uuid(),
        expectedVersion: version,
        reason,
      })
      .strict()
      .parse(raw);
    if (input.fromUserId === input.toUserId)
      throw new ApiError('INVALID_OWNER', 'Choose a different incoming owner.', 400);
    return this.db.transaction(async (tx) => {
      // Match suspension/grant lock order before touching organization/user/invitation rows.
      await tx.query('SELECT pg_advisory_xact_lock(42819209)');
      const org = (await tx.query('SELECT * FROM organizations WHERE id=$1 FOR UPDATE', [id])).rows[0];
      await this.organizations.platformAny(actor, ['admin'], tx);
      if (!org || org.version !== input.expectedVersion)
        throw new ApiError('VERSION_CONFLICT', 'Organization changed.', 409);
      if (
        !(
          await tx.query(
            "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.role='owner' AND (m.status='active' OR (u.status IN ('deleted','deletion-pending') AND NOT EXISTS(SELECT 1 FROM memberships other JOIN users ou ON ou.id=other.user_id WHERE other.organization_id=m.organization_id AND other.role='owner' AND other.status='active' AND ou.status='active')))",
            [id, input.fromUserId],
          )
        ).rowCount
      )
        throw new ApiError('INVALID_OWNER', 'Outgoing owner is not active.', 409);
      const user = (
        await tx.query(
          "SELECT id,email FROM users WHERE id=$1 AND status='active' AND kind='registered' FOR SHARE",
          [input.toUserId],
        )
      ).rows[0];
      if (!user)
        throw new ApiError('INVALID_OWNER', 'Incoming owner must have an active verified account.', 400);
      await tx.query(
        "UPDATE organization_owner_transfers SET state='revoked' WHERE organization_id=$1 AND state='pending'",
        [id],
      );
      const policy = (
        await tx.query(
          'SELECT id FROM commercial_policies WHERE organization_id=$1 ORDER BY version DESC LIMIT 1',
          [id],
        )
      ).rows[0];
      const transferId = randomUUID();
      await tx.query(
        "INSERT INTO organization_owner_transfers(id,organization_id,from_user_id,to_user_id,created_by,reason,organization_version,policy_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '7 days')",
        [
          transferId,
          id,
          input.fromUserId,
          input.toUserId,
          actor.userId,
          input.reason,
          org.version,
          policy?.id ?? null,
        ],
      );
      await notifyBuyer(
        tx,
        this.db.config,
        user.id,
        user.email,
        'organization-owner-invite',
        'Review a Clubby organization ownership request',
        `An administrator has requested that you become an owner of ${org.name}. Review and explicitly accept the responsibilities in your seller account. Ownership request: ${transferId}`,
        `owner-transfer:${transferId}`,
      );
      await audit(tx, actor.userId, 'organization.owner-request', 'organization', id, input.reason, {
        transferId,
        fromUserId: input.fromUserId,
        toUserId: user.id,
      });
      return { data: { id: transferId } };
    });
  }
  async ownerInvitations(actor: Principal) {
    this.organizations.verified(actor);
    return {
      data: (
        await this.db.query(
          "SELECT t.id,t.organization_id,o.name,t.from_user_id,t.expires_at,p.terms,p.commission_bps FROM organization_owner_transfers t JOIN organizations o ON o.id=t.organization_id LEFT JOIN commercial_policies p ON p.id=t.policy_id WHERE t.to_user_id=$1 AND t.state='pending' AND t.expires_at>now() ORDER BY t.created_at",
          [actor.userId],
        )
      ).rows,
    };
  }
  async acceptOwnership(actor: Principal, id: string, raw: unknown) {
    this.organizations.verified(actor);
    z.object({ acceptResponsibilities: z.literal(true) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(42819209)');
      if (
        !(
          await tx.query("SELECT id FROM users WHERE id=$1 AND status='active' AND kind='registered'", [
            actor.userId,
          ])
        ).rowCount
      )
        throw new ApiError('FORBIDDEN', 'An active verified account must accept ownership.', 403);
      const located = (
        await tx.query(
          'SELECT organization_id FROM organization_owner_transfers WHERE id=$1 AND to_user_id=$2',
          [id, actor.userId],
        )
      ).rows[0];
      if (!located) throw new ApiError('NOT_FOUND', 'Ownership request not found.', 404);
      const org = (
        await tx.query('SELECT * FROM organizations WHERE id=$1 FOR UPDATE', [located.organization_id])
      ).rows[0]!;
      const transfer = (
        await tx.query('SELECT * FROM organization_owner_transfers WHERE id=$1 FOR UPDATE', [id])
      ).rows[0]!;
      if (transfer.state === 'accepted') return { data: { organizationId: org.id, accepted: true } };
      if (
        transfer.state !== 'pending' ||
        transfer.expires_at.getTime() <= Date.now() ||
        org.version !== transfer.organization_version
      )
        throw new ApiError(
          'TRANSFER_EXPIRED',
          'Request expired or the organization changed. Request a new review.',
          409,
        );
      const policy = (
        await tx.query(
          'SELECT id FROM commercial_policies WHERE organization_id=$1 ORDER BY version DESC LIMIT 1',
          [org.id],
        )
      ).rows[0];
      if ((policy?.id ?? null) !== transfer.policy_id)
        throw new ApiError(
          'POLICY_CHANGED',
          'Commercial terms changed. Request a new ownership review.',
          409,
        );
      if (
        !(
          await tx.query(
            "SELECT 1 FROM platform_grants g JOIN users u ON u.id=g.user_id WHERE g.user_id=$1 AND g.role='admin' AND g.revoked_at IS NULL AND u.status='active'",
            [transfer.created_by],
          )
        ).rowCount
      )
        throw new ApiError('TRANSFER_REVOKED', 'The administrator authority was revoked.', 409);
      const old = await tx.query(
        "UPDATE memberships m SET status='revoked' WHERE m.organization_id=$1 AND m.user_id=$2 AND m.role='owner' AND (m.status='active' OR (EXISTS(SELECT 1 FROM users u WHERE u.id=m.user_id AND u.status IN ('deleted','deletion-pending')) AND NOT EXISTS(SELECT 1 FROM memberships other JOIN users ou ON ou.id=other.user_id WHERE other.organization_id=m.organization_id AND other.role='owner' AND other.status='active' AND ou.status='active'))) RETURNING id",
        [org.id, transfer.from_user_id],
      );
      if (!old.rowCount) throw new ApiError('OWNER_CHANGED', 'Outgoing ownership changed.', 409);
      await tx.query(
        "INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner') ON CONFLICT(organization_id,user_id) DO UPDATE SET role='owner',venue_ids=NULL,status='active'",
        [randomUUID(), org.id, actor.userId],
      );
      await tx.query(
        'UPDATE staff_invitations SET revoked_at=now() WHERE organization_id=$1 AND inviter_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL',
        [org.id, transfer.from_user_id],
      );
      await tx.query('UPDATE organizations SET version=version+1,privacy_sales_paused=false WHERE id=$1', [
        org.id,
      ]);
      await tx.query(
        "UPDATE organization_owner_transfers SET state='accepted',accepted_at=now() WHERE id=$1",
        [id],
      );
      await audit(
        tx,
        actor.userId,
        'organization.owner-accept',
        'organization',
        org.id,
        'Incoming owner explicitly accepted commercial and operational responsibilities',
        { transferId: id, policyId: transfer.policy_id, previousOwner: transfer.from_user_id },
      );
      return { data: { organizationId: org.id, accepted: true } };
    });
  }
}
