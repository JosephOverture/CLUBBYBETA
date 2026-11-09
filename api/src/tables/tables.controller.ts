import { Body, Controller, Get, Headers, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../identity/session.guard';
import type { IdentityRequest } from '../identity/identity.service';
import { TablesService } from './tables.service';
const uuid = (id: string) => z.string().uuid().parse(id);
@Controller('v1')
export class TablesController {
  constructor(@Inject(TablesService) readonly tables: TablesService) {}
  @Post('seller/venues/:id/layouts') layout(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.tables.layout(req.principal!, id, body);
  }
  @Get('seller/venues/:id/layouts') layouts(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.tables.layouts(req.principal!, id);
  }
  @Post('seller/occurrences/:id/layout') pin(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.tables.pin(req.principal!, uuid(id), body);
  }
  @Post('seller/occurrences/:id/table-offers') offer(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.tables.offer(req.principal!, uuid(id), body);
  }
  @Public() @Get('occurrences/:id/tables') availability(@Param('id') id: string) {
    return this.tables.availability(uuid(id));
  }
  @Post('seller/table-offers/:id/publication') publication(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.tables.offerStatus(req.principal!, uuid(id), body);
  }
  @Post('seller/tables/:id/blocks') block(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.tables.block(req.principal!, uuid(id), body, key);
  }
  @Get('seller/venues/:id/table-blocks') blocks(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.tables.blocks(req.principal!, id);
  }
  @Post('seller/table-blocks/:id/release') releaseBlock(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.tables.releaseBlock(
      req.principal!,
      uuid(id),
      z.object({ reason: z.string() }).strict().parse(body).reason,
    );
  }
  @Post('table-reservations') hold(
    @Req() req: IdentityRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.tables.hold(req.principal!, body, key);
  }
  @Get('table-reservations/:id') view(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.tables.view(req.principal!, uuid(id));
  }
  @Get('seller/table-reservations/:id') staffView(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.tables.view(req.principal!, uuid(id), true);
  }
  @Post('seller/table-reservations/:id/collections') collect(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.tables.collect(req.principal!, uuid(id), body, key);
  }
  @Post('seller/door-collections/:id/reverse') reverse(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.tables.reverseCollection(req.principal!, uuid(id), body, key);
  }
  @Post('seller/table-reservations/:id/no-show') noShow(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.tables.noShow(
      req.principal!,
      uuid(id),
      z.object({ reason: z.string() }).strict().parse(body).reason,
    );
  }
}
