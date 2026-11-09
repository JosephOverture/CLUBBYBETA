import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Public } from '../identity/session.guard';
import type { IdentityRequest } from '../identity/identity.service';
import { OrdersService } from './orders.service';
import { InventoryService } from './inventory.service';
import { SellersService } from './sellers.service';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';
import { AdmissionsService } from './admissions.service';
import { BookingSupportService } from './support.service';
import { BillingService } from './billing.service';
import { SavedMethodsService } from './saved-methods.service';
const uuid = (id: string) => z.string().uuid().parse(id);
@Controller('v1')
export class CommerceController {
  constructor(
    @Inject(OrdersService) readonly orders: OrdersService,
    @Inject(InventoryService) readonly inventory: InventoryService,
    @Inject(SellersService) readonly sellers: SellersService,
    @Inject(PaymentsService) readonly payments: PaymentsService,
    @Inject(RefundsService) readonly refunds: RefundsService,
    @Inject(AdmissionsService) readonly admissions: AdmissionsService,
    @Inject(BookingSupportService) readonly support: BookingSupportService,
    @Inject(BillingService) readonly billing: BillingService,
    @Inject(SavedMethodsService) readonly savedMethods: SavedMethodsService,
  ) {}
  @Public() @Get('occurrences/:id/offers') offers(@Param('id') id: string) {
    return this.inventory.offers(uuid(id));
  }
  @Post('seller/occurrences/:id/products') product(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.inventory.product(req.principal!, uuid(id), body);
  }
  @Post('seller/occurrences/:id/products/:productId') editProduct(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Body() body: unknown,
  ) {
    return this.inventory.product(req.principal!, uuid(id), body, uuid(productId));
  }
  @Post('organizations/:id/promotions') promotion(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.inventory.promotion(req.principal!, uuid(id), body);
  }
  @Post('admin/organizations/:id/policy') policy(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.sellers.policy(req.principal!, uuid(id), body);
  }
  @Post('organizations/:id/policy/:policyId/accept') accept(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Param('policyId') policyId: string,
  ) {
    return this.sellers.accept(req.principal!, uuid(id), uuid(policyId));
  }
  @Get('organizations/:id/commerce') seller(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.sellers.status(req.principal!, uuid(id));
  }
  @Post('organizations/:id/connect') onboard(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.sellers.onboard(req.principal!, uuid(id));
  }
  @Post('organizations/:id/connect/refresh') refresh(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.sellers.refresh(req.principal!, uuid(id));
  }
  @Post('admin/destinations/:id/commerce') market(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.sellers.market(req.principal!, id, body);
  }
  @Post('orders') hold(
    @Req() req: IdentityRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.orders.hold(req.principal!, body, key);
  }
  @Post('orders/quote') quote(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.orders.quote(req.principal!, body);
  }
  @Post('seller/occurrences/:id/capacity') capacity(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.inventory.capacity(req.principal!, uuid(id), body);
  }
  @Post('seller/occurrences/:id/blocks') block(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.inventory.block(req.principal!, uuid(id), body);
  }
  @Get('orders') list(@Req() req: IdentityRequest, @Query('before') before?: string) {
    return this.orders.list(req.principal!, before);
  }
  @Get('orders/:id') order(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.orders.view(req.principal!, uuid(id));
  }
  @Get('orders/:id/receipt') async receipt(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    return reply
      .type('text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
      .send(await this.billing.receipt(req.principal!, uuid(id)));
  }
  @Get('organizations/:id/statement.csv') async statement(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ) {
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="clubby-statement.csv"')
      .send(await this.billing.statement(req.principal!, uuid(id), query));
  }
  @Post('seller/orders/:id/resend') resend(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.billing.resend(
      req.principal!,
      uuid(id),
      z.object({ reason: z.string() }).strict().parse(body).reason,
    );
  }
  @Post('seller/orders/:id/reconcile') recover(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.payments.recoverOrder(req.principal!, uuid(id), body);
  }
  @Post('orders/:id/claim') claim(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.orders.claim(req.principal!, uuid(id));
  }
  @Post('orders/:id/payment') payment(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        acceptTerms: z.literal(true),
        useSavedMethods: z.boolean().optional(),
        saveCard: z.boolean().optional(),
      })
      .strict()
      .parse(body);
    return this.orders.startPayment(req.principal!, uuid(id), input.acceptTerms, input);
  }
  @Get('me/payment-accounts') paymentAccounts(@Req() req: IdentityRequest) {
    return this.savedMethods.sellers(req.principal!);
  }
  @Get('me/payment-accounts/:id/methods') paymentMethods(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query('after') after?: string,
  ) {
    return this.savedMethods.list(req.principal!, uuid(id), after);
  }
  @Post('me/payment-accounts/:id/methods/remove') removeMethod(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.savedMethods.remove(req.principal!, uuid(id), body);
  }
  @Post('orders/:id/cancel') cancel(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.orders.cancel(req.principal!, uuid(id));
  }
  @Post('orders/:id/refunds') refund(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.refunds.request(req.principal!, uuid(id), body, key);
  }
  @Post('seller/orders/:id/refunds') staffRefund(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.refunds.request(req.principal!, uuid(id), body, key, true);
  }
  @Get('tickets/:id') ticket(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.admissions.ticket(req.principal!, uuid(id));
  }
  @Post('admissions/scan') scan(
    @Req() req: IdentityRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.admissions.scan(req.principal!, body, key);
  }
  @Get('admissions/occurrences') assigned(@Req() req: IdentityRequest) {
    return this.admissions.assigned(req.principal!);
  }
  @Get('admissions/occurrences/:id/summary') summary(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.admissions.summary(req.principal!, uuid(id));
  }
  @Post('admissions/manual') manual(
    @Req() req: IdentityRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.admissions.manual(req.principal!, body, key);
  }
  @Post('seller/venues/:id/booking-lookup') lookup(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ orderId: z.string().uuid(), reason: z.string() }).strict().parse(body);
    return this.admissions.lookup(req.principal!, id, input.orderId, input.reason);
  }
  @Post('orders/:id/support') supportCreate(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.support.create(req.principal!, uuid(id), body, key);
  }
  @Post('tickets/:id/support') ticketSupport(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.support.createForTicket(req.principal!, uuid(id), body, key);
  }
  @Get('support') supportList(
    @Req() req: IdentityRequest,
    @Query('organizationId') id?: string,
    @Query('before') before?: string,
    @Query('status') status?: string,
  ) {
    return this.support.list(req.principal!, id ? uuid(id) : undefined, { before, status });
  }
  @Get('admin/support') platformSupport(
    @Req() req: IdentityRequest,
    @Query('before') before?: string,
    @Query('status') status?: string,
  ) {
    return this.support.list(req.principal!, undefined, { platform: true, before, status });
  }
  @Get('admin/support/agents') async supportAgents(@Req() req: IdentityRequest) {
    await this.support.organizations.platformAny(req.principal!, ['admin', 'support']);
    return {
      data: (
        await this.support.db.query(
          "SELECT DISTINCT u.id,u.display_name AS name FROM users u JOIN platform_grants g ON g.user_id=u.id WHERE g.role IN ('admin','support') AND g.revoked_at IS NULL AND u.status='active' ORDER BY u.id",
        )
      ).rows,
    };
  }
  @Post('admin/support/:id/assignment') assignSupport(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.support.assign(req.principal!, uuid(id), body);
  }
  @Get('support/:id') supportView(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query('after') after?: string,
  ) {
    return this.support.view(req.principal!, uuid(id), after);
  }
  @Post('support/:id/messages') supportReply(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.support.reply(req.principal!, uuid(id), body, key);
  }
  @Get('organizations/:id/finance') finance(@Req() req: IdentityRequest, @Param('id') id: string) {
    return this.support.finance(req.principal!, uuid(id));
  }
  @Post('seller/external-refunds/:id/allocate') allocate(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.support.allocateExternalRefund(
      req.principal!,
      z
        .string()
        .regex(/^re_[A-Za-z0-9]+$/)
        .parse(id),
      body,
    );
  }
  @Public() @Post('webhooks/stripe') webhook(
    @Req() req: IdentityRequest & { rawBody?: Buffer },
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.payments.webhook(req.rawBody, signature);
  }
}
