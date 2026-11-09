import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import type { IdentityRequest } from '../identity/identity.service';
import { Public } from '../identity/session.guard';
import { WalletService } from './wallet.service';
@Controller('v1')
export class WalletController {
  constructor(@Inject(WalletService) readonly wallet: WalletService) {}
  @Get('wallet/capabilities') capabilities() {
    return { data: this.wallet.provider.capabilities() };
  }
  @Post('tickets/:id/wallet') issue(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.wallet.issue(req.principal!, z.string().uuid().parse(id), body);
  }
  @Public() @Get('wallet/download/:token') async download(
    @Req() req: IdentityRequest,
    @Param('token') token: string,
    @Res() res: FastifyReply,
  ) {
    return res
      .type('application/vnd.apple.pkpass')
      .header('content-disposition', 'attachment; filename="clubby.pkpass"')
      .header('referrer-policy', 'no-referrer')
      .send(await this.wallet.download(token, req.method === 'HEAD'));
  }
  @Public() @Get('wallet/apple/v1/passes/:passType/:serial') async update(
    @Param('passType') type: string,
    @Param('serial') id: string,
    @Headers('authorization') auth: string | undefined,
    @Res() res: FastifyReply,
  ) {
    return res.type('application/vnd.apple.pkpass').send(await this.wallet.appleUpdate(type, id, auth));
  }
  @Public() @Post('wallet/apple/v1/devices/:device/registrations/:passType/:serial') async register(
    @Param('device') device: string,
    @Param('passType') type: string,
    @Param('serial') id: string,
    @Headers('authorization') auth: string | undefined,
    @Body() body: unknown,
    @Res() res: FastifyReply,
  ) {
    return res.code(await this.wallet.register(device, type, id, auth, body)).send();
  }
  @Public() @Delete('wallet/apple/v1/devices/:device/registrations/:passType/:serial') async remove(
    @Param('device') device: string,
    @Param('passType') type: string,
    @Param('serial') id: string,
    @Headers('authorization') auth: string | undefined,
    @Res() res: FastifyReply,
  ) {
    await this.wallet.unregister(device, type, id, auth);
    return res.code(200).send();
  }
  @Public() @Get('wallet/apple/v1/devices/:device/registrations/:passType') async list(
    @Param('device') device: string,
    @Param('passType') type: string,
    @Query('passesUpdatedSince') since: string | undefined,
    @Res() res: FastifyReply,
  ) {
    const result = await this.wallet.updates(device, type, since);
    return result ? res.send(result) : res.code(204).send();
  }
  @Public() @Post('wallet/apple/v1/log') logs(@Body() body: unknown, @Res() res: FastifyReply) {
    z.object({ logs: z.array(z.string().max(4000)).max(10) })
      .strict()
      .parse(body);
    // Device logs can contain pass authentication material; acknowledge without persisting their contents.
    return res.code(200).send();
  }
}
