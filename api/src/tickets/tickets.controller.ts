import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { IdentityRequest } from '../identity/identity.service';
import { TransfersService } from './transfers.service';
const uuid = (value: string) => z.string().uuid().parse(value);
@Controller('v1')
export class TicketsController {
  constructor(@Inject(TransfersService) readonly transfers: TransfersService) {}
  @Get('tickets') list(@Req() req: IdentityRequest, @Query('after') after?: string) {
    return this.transfers.list(req.principal!, after);
  }
  @Get('tickets/:id/transfers') pending(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.transfers.pending(req.principal!, uuid(id));
  }
  @Post('tickets/:id/transfers') create(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.transfers.create(req.principal!, uuid(id), body, key);
  }
  @Post('ticket-transfers/:id/revoke') revoke(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.transfers.revoke(req.principal!, uuid(id));
  }
  @Post('ticket-transfers/preview') preview(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.transfers.invitation(req.principal!, body);
  }
  @Post('ticket-transfers/accept') accept(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.transfers.invitation(req.principal!, body, true);
  }
}
