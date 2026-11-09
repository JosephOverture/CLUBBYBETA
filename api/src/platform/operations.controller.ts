import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { OperationsService } from './operations.service';
import { IdentityService, type IdentityRequest } from '../identity/identity.service';
@Controller('v1/admin/operations')
export class OperationsController {
  constructor(
    @Inject(OperationsService) readonly operations: OperationsService,
    @Inject(IdentityService) readonly identity: IdentityService,
  ) {}
  @Get() status(@Req() req: IdentityRequest) {
    return this.operations.status(req.principal!);
  }
  @Get('jobs') jobs(@Req() req: IdentityRequest, @Query() raw: unknown) {
    return this.operations.jobs(req.principal!, raw);
  }
  @Post('jobs/:id/replay') async replay(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    await this.identity.requireRecent(req.principal!);
    return this.operations.replay(req.principal!, id, raw);
  }
}
