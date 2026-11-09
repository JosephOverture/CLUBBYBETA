import { Body, Controller, Get, Inject, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { MediaService } from './media.service';
import type { IdentityRequest } from '../identity/identity.service';
import { Public } from '../identity/session.guard';
import { ApiError } from '../platform/http';

@Controller('v1')
export class MediaController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}
  @Post('seller/venues/:id/media') create(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.media.create(req.principal!, id, body);
  }
  @Post('seller/events/:id/media') createForEvent(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.media.createForEvent(req.principal!, z.string().uuid().parse(id), body);
  }
  @Post('seller/events/:id/hero') attachToEvent(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.media.attachToEvent(req.principal!, z.string().uuid().parse(id), body);
  }
  @Put('media/:id/content') upload(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.media.upload(req.principal!, z.string().uuid().parse(id), body);
  }
  @Get('media/:id/status') async status(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.media.inspect(req.principal!, z.string().uuid().parse(id));
  }
  @Get('media/:id/preview/:variant') async preview(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Param('variant') variant: string,
    @Res() reply: FastifyReply,
  ) {
    return reply
      .type('image/webp')
      .send(
        await this.media.preview(
          req.principal!,
          z.string().uuid().parse(id),
          z.enum(['hero', 'thumbnail']).parse(variant),
        ),
      );
  }
  @Post('seller/venues/:id/hero') attach(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.media.attach(req.principal!, id, body);
  }
  @Post('media/:id/delete') remove(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.media.remove(req.principal!, z.string().uuid().parse(id));
  }
  @Public() @Get('media/:id/:variant') async image(
    @Param('id') id: string,
    @Param('variant') variant: string,
    @Res() reply: FastifyReply,
  ) {
    const data = await this.media.publicImage(
      z.string().uuid().parse(id),
      z.enum(['hero', 'thumbnail']).parse(variant),
    );
    return reply.type('image/webp').header('content-disposition', 'inline').send(data);
  }
}
