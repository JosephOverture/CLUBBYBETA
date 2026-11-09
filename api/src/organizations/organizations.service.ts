import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient, QueryResultRow } from 'pg';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { hash, secret } from '../platform/crypto';
import type { Config } from '../platform/config';
import type { Principal } from '../identity/identity.service';
import { notifyBuyer } from '../commerce/core';

export type Permission =
  | 'venue.read'
  | 'venue.edit'
  | 'event.edit'
  | 'event.publish'
  | 'members.manage'
  | 'admissions.redeem'
  | 'finance.read'
  | 'booking.read'
  | 'booking.collect'
  | 'support.manage'
  | 'booking.refund';
const rolePermissions: Record<string, Permission[]> = {
  owner: [
    'venue.read',
    'venue.edit',
    'event.edit',
    'event.publish',
    'members.manage',
    'admissions.redeem',
    'finance.read',
    'booking.read',
    'booking.refund',
    'booking.collect',
    'support.manage',
  ],
  manager: [
    'venue.read',
    'venue.edit',
    'event.edit',
    'event.publish',
    'admissions.redeem',
    'booking.read',
    'booking.refund',
    'booking.collect',
    'support.manage',
  ],
  editor: ['venue.read', 'event.edit'],
  door: ['admissions.redeem', 'booking.read', 'booking.collect'],
  finance: ['finance.read'],
};
export async function audit(
  tx: PoolClient,
  actorId: string | null,
  action: string,
  resourceType: string,
  resourceId: string,
  reason: string,
  metadata: Record<string, unknown> = {},
) {
  await tx.query(
    'INSERT INTO audit_events(actor_id,action,resource_type,resource_id,reason,metadata) VALUES($1,$2,$3,$4,$5,$6)',
    [actorId, action, resourceType, resourceId, reason, JSON.stringify(metadata)],
  );
}
export class OrganizationsService {
  constructor(
    readonly db: Database,
    private readonly config: Config,
  ) {}
  private query<T extends QueryResultRow>(sql: string, values: unknown[], tx?: PoolClient) {
    return tx ? tx.query<T>(sql, values) : this.db.query<T>(sql, values);
  }
  verified(actor: Pick<Principal, 'userId' | 'kind'>) {
    if (actor.kind !== 'registered')
      throw new ApiError('VERIFICATION_REQUIRED', 'Verify your account first.', 403);
  }
  async platform(actor: Principal, role: 'admin' | 'support' | 'finance' = 'admin') {
    this.verified(actor);
    const grant = await this.db.query(
      "SELECT g.role FROM platform_grants g JOIN users u ON u.id=g.user_id WHERE g.user_id=$1 AND g.role=$2 AND g.revoked_at IS NULL AND u.status='active'",
      [actor.userId, role],
    );
    if (!grant.rowCount) throw new ApiError('FORBIDDEN', 'This action requires platform authorization.', 403);
  }
  async platformAny(
    actor: Pick<Principal, 'userId' | 'kind'>,
    roles: ('admin' | 'support' | 'finance')[],
    tx: Pick<Database, 'query'> = this.db,
  ) {
    this.verified(actor);
    if (
      !(
        await tx.query(
          "SELECT 1 FROM platform_grants g JOIN users u ON u.id=g.user_id WHERE g.user_id=$1 AND g.role=ANY($2::text[]) AND g.revoked_at IS NULL AND u.status='active'",
          [actor.userId, roles],
        )
      ).rowCount
    )
      throw new ApiError('FORBIDDEN', 'This action requires platform authorization.', 403);
  }
  async scope(
    actor: Pick<Principal, 'userId' | 'kind'>,
    organizationId: string,
    permission: Permission,
    tx: Pick<Database, 'query'> = this.db,
  ): Promise<string[] | null> {
    this.verified(actor);
    const row = (
      await tx.query(
        "SELECT m.role,m.venue_ids FROM memberships m JOIN organizations o ON o.id=m.organization_id JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='active' AND o.status='approved' AND u.status='active'",
        [organizationId, actor.userId],
      )
    ).rows[0];
    if (!row || !rolePermissions[row.role]?.includes(permission))
      throw new ApiError('FORBIDDEN', 'This action requires seller authorization.', 403);
    return row.venue_ids as string[] | null;
  }
  async capabilities(actor: Principal) {
    const organizations = (await this.list(actor)).data;
    const platform = (
      await this.db.query(
        'SELECT role FROM platform_grants WHERE user_id=$1 AND revoked_at IS NULL ORDER BY role',
        [actor.userId],
      )
    ).rows.map((r) => r.role as string);
    return {
      data: {
        platform,
        organizations: organizations.map((o) => ({
          ...o,
          permissions: o.status === 'approved' ? (rolePermissions[o.role] ?? []) : [],
        })),
      },
    };
  }
  async authorize(
    actor: Principal,
    organizationId: string,
    permission: Permission,
    venueId?: string,
    allowPending = false,
    tx?: PoolClient,
  ) {
    this.verified(actor);
    const result = await this.query<{
      role: string;
      venue_ids: string[] | null;
      organization_status: string;
    }>(
      `SELECT m.role,m.venue_ids,o.status AS organization_status
      FROM memberships m JOIN organizations o ON o.id=m.organization_id JOIN users u ON u.id=m.user_id
      WHERE m.user_id=$1 AND m.organization_id=$2 AND m.status='active' AND u.status='active' ${tx ? 'FOR SHARE OF m,o' : ''}`,
      [actor.userId, organizationId],
      tx,
    );
    const member = result.rows[0];
    if (
      !member ||
      (!allowPending && member.organization_status !== 'approved') ||
      !rolePermissions[member.role]?.includes(permission) ||
      (member.venue_ids && (!venueId || !member.venue_ids.includes(venueId)))
    )
      throw new ApiError('FORBIDDEN', 'You cannot perform this action for this organization or venue.', 403);
  }
  async authorizeVenue(actor: Principal, venueId: string, permission: Permission, tx?: PoolClient) {
    const result = await this.query<{ organization_id: string }>(
      'SELECT organization_id FROM venues WHERE id=$1',
      [venueId],
      tx,
    );
    const organizationId = result.rows[0]?.organization_id;
    if (!organizationId) throw new ApiError('NOT_FOUND', 'Venue not found.', 404);
    await this.authorize(actor, organizationId, permission, venueId, false, tx);
    return organizationId;
  }
  async apply(actor: Principal, raw: unknown) {
    this.verified(actor);
    const input = z
      .object({
        name: z.string().trim().min(2).max(120),
        countryCode: z.string().regex(/^[A-Z]{2}$/),
        legalName: z.string().trim().min(2).max(200),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const id = randomUUID();
      await tx.query('INSERT INTO organizations(id,name,country_code,application) VALUES($1,$2,$3,$4)', [
        id,
        input.name,
        input.countryCode,
        JSON.stringify({ legalName: input.legalName }),
      ]);
      await tx.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')", [
        randomUUID(),
        id,
        actor.userId,
      ]);
      await audit(tx, actor.userId, 'organization.apply', 'organization', id, 'Application submitted');
      return { data: { id, status: 'pending', version: 1 } };
    });
  }
  async list(actor: Principal) {
    this.verified(actor);
    const result = await this.db.query<{
      id: string;
      name: string;
      status: string;
      version: number;
      role: string;
      venueIds: string[] | null;
    }>(
      `SELECT o.id,o.name,o.status,o.version,m.role,m.venue_ids AS "venueIds"
      FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=$1 AND m.status='active' ORDER BY o.name`,
      [actor.userId],
    );
    return { data: result.rows };
  }
  async review(actor: Principal, id: string, raw: unknown) {
    await this.platform(actor);
    const input = z
      .object({
        status: z.enum(['approved', 'rejected', 'suspended']),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(5).max(1000),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        'UPDATE organizations SET status=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING id,status,version',
        [input.status, id, input.expectedVersion],
      );
      if (!result.rowCount)
        throw new ApiError('VERSION_CONFLICT', 'Organization changed or does not exist.', 409);
      await audit(tx, actor.userId, 'organization.review', 'organization', id, input.reason, {
        status: input.status,
      });
      const owners = (
        await tx.query(
          "SELECT u.id,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.role='owner' AND m.status='active' AND u.status='active' AND u.email IS NOT NULL ORDER BY u.id",
          [id],
        )
      ).rows;
      for (const owner of owners)
        await notifyBuyer(
          tx,
          this.config,
          owner.id,
          owner.email,
          'organization-review',
          'Your Clubby seller application was reviewed',
          `Application status: ${input.status}. Open your seller account to review the next steps.`,
          `organization-review:${id}:${result.rows[0].version}:${owner.id}`,
        );
      return { data: result.rows[0] };
    });
  }
  async invite(actor: Principal, id: string, raw: unknown) {
    const input = z
      .object({
        email: z
          .string()
          .email()
          .transform((v) => v.toLowerCase()),
        role: z.enum(['manager', 'editor', 'door', 'finance']),
        venueIds: z.array(z.string().min(1).max(100)).min(1).max(100).nullable().default(null),
      })
      .strict()
      .parse(raw);
    if (this.config.EMAIL_MODE === 'disabled')
      throw new ApiError('NOT_CONFIGURED', 'Invitation delivery is unavailable.', 503);
    return this.db.transaction(async (tx) => {
      await this.authorize(actor, id, 'members.manage', undefined, false, tx);
      if (input.venueIds) {
        const venues = await tx.query(
          'SELECT id FROM venues WHERE organization_id=$1 AND id=ANY($2::text[])',
          [id, input.venueIds],
        );
        if (venues.rowCount !== new Set(input.venueIds).size)
          throw new ApiError(
            'INVALID_SCOPE',
            'Invitation contains venues from a different organization.',
            400,
          );
      }
      const invitationId = randomUUID(),
        token = secret();
      await tx.query(
        `INSERT INTO staff_invitations(id,organization_id,email,role,venue_ids,token_hash,inviter_id,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '7 days')`,
        [invitationId, id, input.email, input.role, input.venueIds, hash(token), actor.userId],
      );
      await notifyBuyer(
        tx,
        this.config,
        null,
        input.email,
        'staff-invitation',
        'Clubby staff invitation',
        `Sign in with this email address in Clubby and accept invitation ${invitationId} with code ${token}.`,
        `staff-invite:${invitationId}`,
      );
      await audit(
        tx,
        actor.userId,
        'membership.invite',
        'invitation',
        invitationId,
        'Staff invitation created',
        { role: input.role },
      );
      return { data: { id: invitationId } };
    });
  }
  async accept(actor: Principal, raw: unknown) {
    this.verified(actor);
    const input = z
      .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const result = await tx.query<{
        id: string;
        organization_id: string;
        email: string;
        role: string;
        venue_ids: string[] | null;
        inviter_id: string;
      }>(
        `SELECT * FROM staff_invitations WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`,
        [hash(input.token)],
      );
      const invite = result.rows[0];
      if (!invite || invite.email !== actor.email)
        throw new ApiError('INVALID_INVITATION', 'Invitation is invalid or belongs to another email.', 403);
      // Revalidate inviter authority at acceptance; a revoked owner cannot keep granting access.
      const inviter = await tx.query(
        "SELECT m.id FROM memberships m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 AND m.organization_id=$2 AND m.role='owner' AND m.venue_ids IS NULL AND m.status='active' AND u.status='active' AND o.status='approved'",
        [invite.inviter_id, invite.organization_id],
      );
      if (!inviter.rowCount)
        throw new ApiError('INVALID_INVITATION', 'Invitation authority was revoked.', 403);
      const member = await tx.query(
        `INSERT INTO memberships(id,organization_id,user_id,role,venue_ids) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(organization_id,user_id) DO UPDATE SET role=EXCLUDED.role,venue_ids=EXCLUDED.venue_ids,status='active'
        WHERE memberships.role<>'owner' RETURNING id`,
        [randomUUID(), invite.organization_id, actor.userId, invite.role, invite.venue_ids],
      );
      if (!member.rowCount)
        throw new ApiError('CONFLICT', 'An owner membership cannot be replaced by an invitation.', 409);
      await tx.query('UPDATE staff_invitations SET accepted_at=now() WHERE id=$1', [invite.id]);
      await audit(
        tx,
        actor.userId,
        'membership.accept',
        'organization',
        invite.organization_id,
        'Invitation accepted',
      );
      return { data: { organizationId: invite.organization_id } };
    });
  }
  async revoke(actor: Principal, id: string, memberId: string, reason: string) {
    return this.db.transaction(async (tx) => {
      await this.authorize(actor, id, 'members.manage', undefined, false, tx);
      const member = await tx.query<{ user_id: string; role: string }>(
        'SELECT user_id,role FROM memberships WHERE id=$1 AND organization_id=$2 FOR UPDATE',
        [memberId, id],
      );
      if (!member.rows[0]) throw new ApiError('NOT_FOUND', 'Membership not found.', 404);
      if (member.rows[0].role === 'owner')
        throw new ApiError('OWNER_PROTECTED', 'Owner changes require platform review.', 409);
      await tx.query("UPDATE memberships SET status='revoked' WHERE id=$1", [memberId]);
      await tx.query(
        'UPDATE staff_invitations SET revoked_at=now() WHERE organization_id=$1 AND email=(SELECT email FROM users WHERE id=$2) AND accepted_at IS NULL',
        [id, member.rows[0].user_id],
      );
      await audit(tx, actor.userId, 'membership.revoke', 'membership', memberId, reason);
      return { data: { revoked: true } };
    });
  }
  async revokeInvitation(actor: Principal, id: string, invitationId: string, reason: string) {
    return this.db.transaction(async (tx) => {
      await this.authorize(actor, id, 'members.manage', undefined, false, tx);
      const result = await tx.query(
        'UPDATE staff_invitations SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL RETURNING id',
        [invitationId, id],
      );
      if (!result.rowCount) throw new ApiError('NOT_FOUND', 'Pending invitation not found.', 404);
      await audit(tx, actor.userId, 'invitation.revoke', 'invitation', invitationId, reason);
      return { data: { revoked: true } };
    });
  }
}
