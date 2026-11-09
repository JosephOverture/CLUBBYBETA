import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { IdentityRequest } from '../identity/identity.service';
import { OrganizationsService } from './organizations.service';

@Controller('v1')
export class OrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly organizations: OrganizationsService) {}
  @Get('me/access') capabilities(@Req() req: IdentityRequest) {
    return this.organizations.capabilities(req.principal!);
  }
  @Get('organizations') list(@Req() req: IdentityRequest) {
    return this.organizations.list(req.principal!);
  }
  @Get('admin/organizations') async applications(@Req() req: IdentityRequest, @Query() raw: unknown) {
    await this.organizations.platform(req.principal!);
    const input = z
      .object({
        before: z.string().uuid().optional(),
        status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional(),
      })
      .strict()
      .parse(raw);
    const rows = (
      await this.organizations.db.query(
        'SELECT id,name,country_code,status,application,version,created_at FROM organizations WHERE ($1::uuid IS NULL OR id<$1) AND ($2::text IS NULL OR status=$2) ORDER BY id DESC LIMIT 100',
        [input.before ?? null, input.status ?? null],
      )
    ).rows;
    return { data: rows, meta: { nextCursor: rows.length === 100 ? rows.at(-1)!.id : null } };
  }
  @Get('organizations/:id/members') async members(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query() raw: unknown,
  ) {
    z.string().uuid().parse(id);
    const { before } = z.object({ before: z.string().uuid().optional() }).strict().parse(raw);
    await this.organizations.authorize(req.principal!, id, 'members.manage');
    const rows = (
      await this.organizations.db.query(
        'SELECT m.id,m.user_id,m.role,m.status,m.venue_ids,u.display_name AS "displayName",u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND ($2::uuid IS NULL OR m.id<$2) ORDER BY m.id DESC LIMIT 51',
        [id, before ?? null],
      )
    ).rows;
    return { data: rows.slice(0, 50), meta: { nextCursor: rows.length > 50 ? rows[49]!.id : null } };
  }
  @Post('organizations/:id/invitations/:invitationId/revoke') async revokeInvitation(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
    @Body() body: unknown,
  ) {
    z.string().uuid().parse(id);
    z.string().uuid().parse(invitationId);
    const { reason } = z
      .object({ reason: z.string().trim().min(5).max(1000) })
      .strict()
      .parse(body);
    return this.organizations.revokeInvitation(req.principal!, id, invitationId, reason);
  }
  @Post('organizations') apply(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.organizations.apply(req.principal!, body);
  }
  @Post('admin/organizations/:id/review') review(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.organizations.review(req.principal!, z.string().uuid().parse(id), body);
  }
  @Post('organizations/:id/invitations') invite(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.organizations.invite(req.principal!, z.string().uuid().parse(id), body);
  }
  @Post('invitations/accept') accept(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.organizations.accept(req.principal!, body);
  }
  @Post('organizations/:id/members/:memberId/revoke') revoke(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({ reason: z.string().trim().min(5).max(1000) })
      .strict()
      .parse(body);
    return this.organizations.revoke(
      req.principal!,
      z.string().uuid().parse(id),
      z.string().uuid().parse(memberId),
      input.reason,
    );
  }
  @Get('admin/audit') async audit(@Req() req: IdentityRequest, @Query() raw: unknown) {
    await this.organizations.platform(req.principal!);
    const input = z
      .object({
        before: z
          .string()
          .regex(/^[0-9]{1,18}$/)
          .optional(),
        actorId: z.string().uuid().optional(),
        resourceId: z.string().min(1).max(200).optional(),
        action: z.string().min(1).max(100).optional(),
      })
      .strict()
      .parse(raw);
    const result = await this.organizations.db.query(
      'SELECT id::text,actor_id,action,resource_type,resource_id,reason,metadata,created_at FROM audit_events WHERE ($1::bigint IS NULL OR audit_events.id<$1) AND ($2::uuid IS NULL OR actor_id=$2) AND ($3::text IS NULL OR resource_id=$3) AND ($4::text IS NULL OR action=$4) ORDER BY audit_events.id DESC LIMIT 100',
      [input.before ?? null, input.actorId ?? null, input.resourceId ?? null, input.action ?? null],
    );
    return {
      data: result.rows,
      meta: { nextCursor: result.rows.length === 100 ? result.rows.at(-1)!.id : null },
    };
  }
}
