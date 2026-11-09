import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { IdentityRequest } from '../identity/identity.service';
import { GroupsService } from './groups.service';
import { ChatService } from './chat.service';
const uuid = (id: string) => z.string().uuid().parse(id);
const reason = (body: unknown) =>
  z
    .object({ reason: z.string().min(10).max(1000) })
    .strict()
    .parse(body).reason;
@Controller('v1')
export class GroupsController {
  constructor(
    @Inject(GroupsService) readonly groups: GroupsService,
    @Inject(ChatService) readonly chat: ChatService,
  ) {}
  @Get('seller/group-financial-reviews') reviews(@Req() req: IdentityRequest) {
    return this.groups.sellerReviews(req.principal!);
  }
  @Get('groups') list(@Req() req: IdentityRequest) {
    return this.groups.list(req.principal!);
  }
  @Post('groups') create(
    @Req() req: IdentityRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.groups.create(req.principal!, body, key);
  }
  @Get('groups/:id') view(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.groups.view(req.principal!, uuid(id));
  }
  @Post('groups/:id/invitations') invite(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.groups.invite(req.principal!, uuid(id), body);
  }
  @Post('group-invitations/accept') accept(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.groups.accept(
      req.principal!,
      z
        .object({ token: z.string(), acceptTerms: z.literal(true) })
        .strict()
        .parse(body).token,
    );
  }
  @Post('group-invitations/preview') preview(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.groups.previewInvitation(
      req.principal!,
      z.object({ token: z.string() }).strict().parse(body).token,
    );
  }
  @Post('seller/groups/:id/refund-review') review(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.groups.sellerReview(req.principal!, uuid(id), reason(body));
  }
  @Post('groups/:id/invitations/:inviteId/revoke') revoke(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.groups.revokeInvite(req.principal!, uuid(id), uuid(inviteId));
  }
  @Post('groups/:id/contributions') contribute(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.groups.contribute(req.principal!, uuid(id), body, key);
  }
  @Post('groups/:id/contributions/:contributionId/withdraw') withdraw(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Param('contributionId') contributionId: string,
  ) {
    return this.groups.withdraw(req.principal!, uuid(id), uuid(contributionId));
  }
  @Post('groups/:id/cancel') cancel(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.groups.cancel(req.principal!, uuid(id), reason(body));
  }
  @Post('groups/:id/leave') leave(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.groups.leave(req.principal!, uuid(id), body);
  }
  @Post('groups/:id/members/:userId/remove') remove(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    return this.groups.leave(req.principal!, uuid(id), body, uuid(userId));
  }
  @Post('groups/:id/ownership') ownership(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.groups.offerOwnership(
      req.principal!,
      uuid(id),
      z.object({ userId: z.string().uuid() }).strict().parse(body).userId,
    );
  }
  @Post('groups/:id/ownership/:transferId/accept') acceptOwnership(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Param('transferId') transferId: string,
    @Body() body: unknown,
  ) {
    return this.groups.acceptOwnership(
      req.principal!,
      uuid(id),
      uuid(transferId),
      z
        .object({ acceptBalanceResponsibility: z.literal(true) })
        .strict()
        .parse(body).acceptBalanceResponsibility,
    );
  }
  @Post('groups/:id/ownership/recover') recoverOwnership(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    z.object({ acceptBalanceResponsibility: z.literal(true) })
      .strict()
      .parse(body);
    return this.groups.acceptOwnership(req.principal!, uuid(id), 'vacant', true);
  }
  @Get('groups/:id/messages') messages(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query('after') after?: string,
  ) {
    return this.chat.history(req.principal!, uuid(id), after);
  }
  @Post('groups/:id/messages') send(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.chat.send(req.principal!, uuid(id), body, key);
  }
  @Get('groups/:id/updates') updates(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query('after') after?: string,
  ) {
    return this.chat.events(req.principal!, uuid(id), after);
  }
  @Post('groups/:id/messages/:messageId/report') report(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    return this.chat.report(req.principal!, uuid(id), uuid(messageId), reason(body));
  }
  @Post('me/blocked-users/:id') block(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.block(
      req.principal!,
      uuid(id),
      z.object({ blocked: z.boolean() }).strict().parse(body).blocked,
    );
  }
  @Get('admin/message-reports') reports(@Req() req: IdentityRequest) {
    return this.chat.reports(req.principal!);
  }
  @Post('admin/message-reports/:id/resolve') moderate(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.chat.moderate(req.principal!, uuid(id), body);
  }
}
