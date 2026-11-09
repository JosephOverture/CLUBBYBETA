import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { IdentityRequest } from '../identity/identity.service';
import { ReportingService } from './reporting.service';
const uuid = (value: string) => z.string().uuid().parse(value);
@Controller('v1')
export class ReportingController {
  constructor(@Inject(ReportingService) readonly reporting: ReportingService) {}
  @Get('organizations/:id/reports') report(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    return this.reporting.report(req.principal!, uuid(id), query);
  }
  @Get('admin/reports') platform(@Req() req: IdentityRequest, @Query() query: unknown) {
    return this.reporting.report(req.principal!, null, query);
  }
  @Post('organizations/:id/report-exports') export(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.reporting.requestExport(req.principal!, uuid(id), body, key);
  }
  @Post('admin/report-exports') platformExport(
    @Req() req: IdentityRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.reporting.requestExport(req.principal!, null, body, key);
  }
  @Get('report-exports/:id') status(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.reporting.export(req.principal!, uuid(id));
  }
  @Get('report-exports/:id/csv') async csv(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    const value = await this.reporting.csv(req.principal!, uuid(id));
    return reply
      .type('text/csv; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-disposition', `attachment; filename="clubby-report-${id}.csv"`)
      .send(value);
  }
  @Get('report-exports/:id/document') async document(@Req() req: IdentityRequest, @Param('id') id: string) {
    return {
      data: {
        filename: `clubby-report-${uuid(id)}.csv`,
        contentType: 'text/csv',
        contents: await this.reporting.csv(req.principal!, id),
      },
    };
  }
}
