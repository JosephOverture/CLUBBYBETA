import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { IdentityRequest } from '../identity/identity.service';
import { Public } from '../identity/session.guard';
import { NotificationsService } from './notifications.service';
import { EmailFeedbackService } from './email-feedback';
@Controller('v1')
export class NotificationsController {
  constructor(
    @Inject(NotificationsService) readonly notifications: NotificationsService,
    @Inject(EmailFeedbackService) readonly feedback: EmailFeedbackService,
  ) {}
  @Get('me/preferences') preferences(@Req() req: IdentityRequest) {
    return this.notifications.preferences(req.principal!);
  }
  @Post('me/preferences') update(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.notifications.updatePreferences(req.principal!, body);
  }
  @Get('me/notifications') inbox(@Req() req: IdentityRequest, @Query('before') before?: string) {
    return this.notifications.inbox(req.principal!, before);
  }
  @Post('me/notifications/:id/read') read(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.notifications.read(req.principal!, id);
  }
  @Get('me/notifications/:id') detail(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.notifications.detail(req.principal!, id);
  }
  @Get('me/devices') devices(@Req() req: IdentityRequest) {
    return this.notifications.devices(req.principal!);
  }
  @Post('me/devices') register(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.notifications.register(req.principal!, body);
  }
  @Post('me/devices/:id/remove') remove(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.notifications.unregister(req.principal!, id);
  }
  @Get('admin/users/:id/deliveries') deliveries(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.feedback.support(req.principal!, id);
  }
  @Post('admin/email-suppressions/release') release(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.feedback.release(req.principal!, body);
  }
  @Public() @Post('webhooks/resend') webhook(@Req() req: IdentityRequest & { rawBody?: Buffer }) {
    return this.feedback.webhook(req.rawBody, req.headers);
  }
}
