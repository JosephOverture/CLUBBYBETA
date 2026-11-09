import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { PrivacyService } from './privacy.service';
import { IdentityService, type IdentityRequest } from '../identity/identity.service';
import { Public } from '../identity/session.guard';

@Controller('v1/privacy')
export class PrivacyController {
  constructor(
    @Inject(PrivacyService) private readonly privacy: PrivacyService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  @Post('requests') async request(@Req() req: IdentityRequest, @Body() body: unknown) {
    await this.identity.requireRecent(req.principal!);
    return this.privacy.request(req.principal!, body);
  }
  @Get('requests/:id') status(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.privacy.status(req.principal!, id);
  }
  @Get('requests/:id/export') download(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.privacy.export(req.principal!, id);
  }
  @Get('requests') list(@Req() req: IdentityRequest) {
    return this.privacy.list(req.principal!);
  }
  @Public() @Post('receipt') receipt(@Body() body: unknown) {
    return this.privacy.receipt(body);
  }
  @Get('operations') operations(@Req() req: IdentityRequest) {
    return this.privacy.operations(req.principal!);
  }
  @Post('operations/:id/retry') async retry(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.identity.requireRecent(req.principal!);
    return this.privacy.retry(req.principal!, id, body);
  }
  @Get('users/:id/holds') holds(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.privacy.holds(req.principal!, id);
  }
  @Post('users/:id/holds') async hold(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.identity.requireRecent(req.principal!);
    return this.privacy.hold(req.principal!, id, body);
  }
  @Post('holds/:id/release') async release(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.identity.requireRecent(req.principal!);
    return this.privacy.releaseHold(req.principal!, id, body);
  }
  @Post('holds/:id/access') async retained(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.identity.requireRecent(req.principal!);
    return this.privacy.retained(req.principal!, id, body);
  }
}
