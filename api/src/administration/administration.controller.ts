import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { AdministrationService } from './administration.service';
import { IdentityService, type IdentityRequest } from '../identity/identity.service';
import { idSchema } from '@clubby/contracts';
@Controller('v1')
export class AdministrationController {
  constructor(
    @Inject(AdministrationService) readonly admin: AdministrationService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @Get('admin/users') users(@Req() req: IdentityRequest, @Query() query: unknown) {
    return this.admin.users(req.principal!, query);
  }
  @Post('admin/users/:id/status') async status(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.identity.requireRecent(req.principal!);
    return this.admin.userStatus(req.principal!, z.string().uuid().parse(id), body);
  }
  @Get('admin/users/:id/grants') grants(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.admin.grants(req.principal!, z.string().uuid().parse(id));
  }
  @Post('admin/users/:id/grants') async grant(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.identity.requireRecent(req.principal!);
    return this.admin.grant(req.principal!, z.string().uuid().parse(id), body);
  }
  @Get('admin/markets') markets(@Req() req: IdentityRequest) {
    return this.admin.markets(req.principal!);
  }
  @Get('admin/organizations/:id') organization(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.admin.organization(req.principal!, z.string().uuid().parse(id));
  }
  @Post('admin/organization-ownership/:id/revoke') async revoke(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.identity.requireRecent(req.principal!);
    return this.admin.revokeOwnership(req.principal!, z.string().uuid().parse(id), body);
  }
  @Post('admin/destinations/:id/market-review') async review(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.identity.requireRecent(req.principal!);
    return this.admin.reviewMarket(req.principal!, idSchema.parse(id), body);
  }
  @Post('admin/organizations/:id/ownership') async owner(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.identity.requireRecent(req.principal!);
    return this.admin.prepareOwnerTransfer(req.principal!, z.string().uuid().parse(id), body);
  }
  @Get('me/organization-ownership-invitations') invitations(@Req() req: IdentityRequest) {
    return this.admin.ownerInvitations(req.principal!);
  }
  @Post('organization-ownership/:id/accept') async accept(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.identity.requireRecent(req.principal!);
    return this.admin.acceptOwnership(req.principal!, z.string().uuid().parse(id), body);
  }
}
