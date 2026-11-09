import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Put, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../identity/session.guard';
import { CONFIG, type Config } from '../platform/config';
import { ApiError } from '../platform/http';
import { BETA_COOKIE, BETA_SESSION_SECONDS, BetaService, type BetaState } from './beta.service';

@Controller('v1/beta')
@Public()
export class BetaController {
  constructor(
    @Inject(BetaService) private readonly beta: BetaService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: ['staging', 'production'].includes(this.config.APP_ENV),
      sameSite: 'lax' as const,
      path: '/v1/beta',
      maxAge: BETA_SESSION_SECONDS,
    };
  }

  private allowWrite(request: FastifyRequest) {
    // Anonymous visitors are still private sessions. Require an explicit allowed
    // browser origin for every mutation, including requests with no JSON body.
    if (!request.headers.origin || !this.config.webOrigins.includes(request.headers.origin))
      throw new ApiError('ORIGIN_DENIED', 'Request origin is not allowed.', 403);
  }

  private async result(
    reply: FastifyReply,
    operation: Promise<{ data: BetaState; token?: string }>,
  ) {
    const result = await operation;
    if (result.token) reply.setCookie(BETA_COOKIE, result.token, this.cookieOptions());
    return { data: result.data };
  }

  @Get('state')
  state(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.result(reply, this.beta.read(request.cookies[BETA_COOKIE]));
  }

  @Put('saved/:venueId')
  save(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply,
    @Param('venueId') venueId: string, @Body() body: unknown) {
    this.allowWrite(request);
    return this.result(reply, this.beta.save(request.cookies[BETA_COOKIE], venueId, body));
  }

  @Post('plans')
  @HttpCode(201)
  plan(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: unknown) {
    this.allowWrite(request);
    return this.result(reply, this.beta.plan(request.cookies[BETA_COOKIE], body));
  }

  @Delete('plans/:id')
  removePlan(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param('id') id: string) {
    this.allowWrite(request);
    return this.result(reply, this.beta.removePlan(request.cookies[BETA_COOKIE], id));
  }

  @Patch('profile')
  profile(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: unknown) {
    this.allowWrite(request);
    return this.result(reply, this.beta.profile(request.cookies[BETA_COOKIE], body));
  }

  @Delete('state')
  async reset(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    this.allowWrite(request);
    const result = await this.beta.reset(request.cookies[BETA_COOKIE]);
    reply.clearCookie(BETA_COOKIE, this.cookieOptions());
    return result;
  }
}
