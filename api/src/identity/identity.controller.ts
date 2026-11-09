import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { IdentityService, type Credentials, type IdentityRequest } from './identity.service';
import { Public } from './session.guard';
import { ApiError } from '../platform/http';
import { secret, hash, encrypt, decrypt } from '../platform/crypto';
import { AppleService } from './apple.service';
import { AppleNotificationsService } from './apple-notifications.service';

@Controller('v1/auth')
export class IdentityController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AppleService) readonly apple: AppleService,
    @Inject(AppleNotificationsService) readonly appleNotifications: AppleNotificationsService,
  ) {}
  @Public() @Post('apple/notifications') @HttpCode(200) appleNotification(@Body() body: unknown) {
    return this.appleNotifications.receive(body);
  }
  @Public() @Get('apple/config') appleConfig() {
    return { data: { enabled: this.apple.enabled() } };
  }
  @Public() @Post('apple/start') appleStart(@Body() body: unknown) {
    return this.apple.start(body);
  }
  @Public() @Post('apple/complete') async appleComplete(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.respond(await this.apple.complete(body), reply);
  }
  @Post('apple/link/start') async appleLinkStart(@Body() body: unknown, @Req() req: IdentityRequest) {
    await this.identity.requireRecent(req.principal!);
    return this.apple.start(body, req.principal!);
  }
  @Post('apple/link/complete') async appleLinkComplete(
    @Body() body: unknown,
    @Req() req: IdentityRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.identity.requireRecent(req.principal!);
    return this.respond(await this.apple.complete(body, req.principal!), reply);
  }
  private respond(credentials: Credentials, reply: FastifyReply) {
    if (credentials.channel === 'web') {
      reply.setCookie(this.identity.cookieName(), credentials.token, {
        httpOnly: true,
        secure: !['development', 'test'].includes(this.identity.config.APP_ENV),
        sameSite: 'lax',
        path: '/',
        maxAge: 8 * 3600,
      });
      return {
        data: {
          userId: credentials.userId,
          csrfToken: credentials.csrfToken,
          expiresAt: credentials.expiresAt,
        },
      };
    }
    return { data: credentials };
  }
  @Public() @Post('email/start') @HttpCode(202) start(@Body() body: unknown) {
    return this.identity.start(body);
  }
  @Public() @Post('email/complete') async complete(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.respond(await this.identity.complete(body), reply);
  }
  @Public() @Post('guest') async guest(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.respond(await this.identity.guest(body), reply);
  }
  @Public() @Post('refresh') async refresh(@Body() body: unknown) {
    return { data: await this.identity.refresh(body) };
  }
  @Public() @Post('oidc/start') oidcStart(@Body() body: unknown) {
    return this.identity.oidcStart(body);
  }
  @Public() @Post('oidc/complete') async oidcComplete(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.respond(await this.identity.oidcComplete(body), reply);
  }
  @Post('oidc/link') async oidcLink(
    @Body() body: unknown,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.identity.requireRecent(request.principal!);
    return this.respond(await this.identity.oidcComplete(body, request.principal!), reply);
  }
  @Get('session') async session(@Req() request: IdentityRequest) {
    const actor = request.principal!;
    const result = await this.identity.db.query(
      'SELECT id,email,display_name AS "displayName",kind FROM users WHERE id=$1',
      [actor.userId],
    );
    return { data: result.rows[0] };
  }
  @Post('csrf') async csrf(@Req() request: IdentityRequest) {
    // The current CSRF credential is required by the guard; use the GET recovery route after a page refresh.
    return this.csrfRecovery(request);
  }
  @Get('csrf') async csrfRecovery(@Req() request: IdentityRequest) {
    return this.identity.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          'SELECT csrf_encrypted FROM sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE',
          [request.principal!.sessionId],
        )
      ).rows[0];
      if (!row) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.', 401);
      if (row.csrf_encrypted)
        return { data: { csrfToken: decrypt(row.csrf_encrypted, this.identity.config.encryptionKeys) } };
      // Older sessions receive one migration token; recovery no longer invalidates other browser tabs.
      const token = secret();
      await tx.query('UPDATE sessions SET csrf_hash=$1,csrf_encrypted=$2 WHERE id=$3', [
        hash(token),
        encrypt(token, this.identity.config.encryptionKeys),
        request.principal!.sessionId,
      ]);
      return { data: { csrfToken: token } };
    });
  }
  @Post('logout') async logout(
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const input = z
      .object({ all: z.boolean().default(false) })
      .strict()
      .parse(body ?? {});
    reply.clearCookie(this.identity.cookieName(), { path: '/' });
    return this.identity.logout(request.principal!, input.all);
  }
  @Post('profile') async profile(@Req() request: IdentityRequest, @Body() body: unknown) {
    if (request.principal!.kind !== 'registered')
      throw new ApiError('VERIFICATION_REQUIRED', 'Verify your account first.', 403);
    const input = z
      .object({ displayName: z.string().trim().min(1).max(100) })
      .strict()
      .parse(body);
    await this.identity.db.query('UPDATE users SET display_name=$1,updated_at=now() WHERE id=$2', [
      input.displayName,
      request.principal!.userId,
    ]);
    return { data: input };
  }
}
