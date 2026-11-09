import Stripe from 'stripe';
import type { Config } from '../platform/config';
import { ApiError } from '../platform/http';

export type Payment = {
  id: string;
  status: string;
  amount: number;
  received: number;
  currency: string;
  commission: number;
  orderId: string;
  attemptId: string;
  clientSecret: string | null;
  chargeId: string | null;
  livemode: boolean;
  customerId?: string | null;
  saveForFuture?: boolean;
};
export type Seller = {
  id: string;
  charges: boolean;
  payouts: boolean;
  valid: boolean;
  livemode: boolean;
  requirements: unknown;
};
export type Refund = {
  id: string;
  status: string;
  amount: number;
  paymentId: string;
  refundId: string;
  currency: string;
};
export interface PaymentProvider {
  createCustomer(account: string, reference: string, userId: string, key: string): Promise<string>;
  findCustomer(account: string, reference: string): Promise<string | null>;
  customerSession(account: string, customer: string, channel: 'web' | 'ios'): Promise<string>;
  cards(
    account: string,
    customer: string,
    after?: string,
  ): Promise<{
    data: { id: string; brand: string; last4: string; expMonth: number; expYear: number }[];
    hasMore: boolean;
  }>;
  removeCard(account: string, customer: string, method: string, key: string): Promise<void>;
  ownsCard(account: string, customer: string, method: string): Promise<boolean>;
  allowCardRedisplay(
    account: string,
    customer: string,
    paymentId: string,
    key: string,
  ): Promise<'saved' | 'removed'>;
  deleteCustomer(account: string, customer: string): Promise<void>;
  createSeller(
    input: { organizationId: string; name: string; country: string; email: string },
    key: string,
  ): Promise<Seller>;
  seller(id: string): Promise<Seller>;
  onboarding(account: string, origin: string): Promise<{ url: string; expiresAt: string }>;
  createPayment(
    input: {
      orderId: string;
      attemptId: string;
      account: string;
      amount: number;
      commission: number;
      currency: string;
      customerId?: string | null;
      saveCard?: boolean;
    },
    key: string,
  ): Promise<Payment>;
  payment(account: string, id: string): Promise<Payment>;
  cancelPayment(account: string, id: string, key: string): Promise<Payment>;
  createRefund(
    input: {
      account: string;
      paymentId: string;
      amount: number;
      refundId: string;
      refundCommission: boolean;
    },
    key: string,
  ): Promise<Refund>;
  refund(account: string, id: string): Promise<Refund>;
  refundFee(feeId: string, amount: number, key: string): Promise<string>;
  refunds(account: string, paymentId: string): Promise<Refund[]>;
  charge(account: string, id: string): Promise<Stripe.Charge>;
  dispute(account: string, id: string): Promise<Stripe.Dispute>;
  payout(account: string, id: string): Promise<Stripe.Payout>;
  transactions(
    account: string,
    after?: string,
  ): Promise<{ data: Stripe.BalanceTransaction[]; hasMore: boolean }>;
  balance(account: string): Promise<Stripe.Balance>;
}
export class StripeProvider implements PaymentProvider {
  readonly stripe: Stripe;
  constructor(
    readonly config: Config,
    client?: Stripe,
  ) {
    this.stripe =
      client ??
      new Stripe(config.STRIPE_SECRET_KEY ?? 'sk_test_disabled', {
        apiVersion: '2026-08-26.dahlia',
        timeout: 10_000,
        maxNetworkRetries: 0,
      });
  }
  enabled() {
    if (this.config.STRIPE_MODE === 'disabled')
      throw new ApiError('PAYMENTS_NOT_CONFIGURED', 'Stripe is not connected yet.', 503);
  }
  async createCustomer(account: string, reference: string, userId: string, key: string) {
    this.enabled();
    return (
      await this.stripe.customers.create(
        { metadata: { clubby_mapping_id: reference, clubby_user_id: userId } },
        { stripeAccount: account, idempotencyKey: key },
      )
    ).id;
  }
  async findCustomer(account: string, reference: string) {
    this.enabled();
    if (!/^[a-f0-9-]{36}$/.test(reference)) throw new Error('Invalid customer mapping reference.');
    const result = await this.stripe.customers.search(
      { query: `metadata['clubby_mapping_id']:'${reference}'`, limit: 2 },
      { stripeAccount: account },
    );
    if (result.data.length > 1) throw new Error('Multiple Stripe customers require review.');
    return result.data[0]?.id ?? null;
  }
  async customerSession(account: string, customer: string, channel: 'web' | 'ios') {
    this.enabled();
    const common = {
      payment_method_redisplay: 'enabled' as const,
      payment_method_remove: 'enabled' as const,
      payment_method_save: 'disabled' as const,
      payment_method_allow_redisplay_filters: ['always' as const],
    };
    const value = await this.stripe.customerSessions.create(
      {
        customer,
        components:
          channel === 'ios'
            ? { mobile_payment_element: { enabled: true, features: common } }
            : { payment_element: { enabled: true, features: common } },
      },
      { stripeAccount: account },
    );
    return value.client_secret;
  }
  async cards(account: string, customer: string, after?: string) {
    this.enabled();
    const result = await this.stripe.paymentMethods.list(
      {
        customer,
        type: 'card',
        allow_redisplay: 'always',
        limit: 50,
        ...(after ? { starting_after: after } : {}),
      },
      { stripeAccount: account },
    );
    return {
      data: result.data
        .filter((v) => v.card)
        .map((v) => ({
          id: v.id,
          brand: v.card!.brand,
          last4: v.card!.last4,
          expMonth: v.card!.exp_month,
          expYear: v.card!.exp_year,
        })),
      hasMore: result.has_more,
    };
  }
  async removeCard(account: string, customer: string, method: string, key: string) {
    this.enabled();
    const value = await this.stripe.paymentMethods.retrieve(method, {}, { stripeAccount: account });
    const owner = typeof value.customer === 'string' ? value.customer : value.customer?.id;
    if (!owner) return;
    if (owner !== customer) throw new ApiError('NOT_FOUND', 'Saved method not found.', 404);
    await this.stripe.paymentMethods.detach(method, {}, { stripeAccount: account, idempotencyKey: key });
  }
  async ownsCard(account: string, customer: string, method: string) {
    this.enabled();
    const value = await this.stripe.paymentMethods.retrieve(method, {}, { stripeAccount: account });
    return (typeof value.customer === 'string' ? value.customer : value.customer?.id) === customer;
  }
  async allowCardRedisplay(account: string, customer: string, paymentId: string, key: string) {
    this.enabled();
    const payment = await this.stripe.paymentIntents.retrieve(paymentId, {}, { stripeAccount: account });
    const paymentCustomer = typeof payment.customer === 'string' ? payment.customer : payment.customer?.id;
    const method =
      typeof payment.payment_method === 'string' ? payment.payment_method : payment.payment_method?.id;
    if (
      payment.status !== 'succeeded' ||
      payment.setup_future_usage !== 'on_session' ||
      paymentCustomer !== customer ||
      !method
    )
      throw new Error('Saved card consent does not match the captured payment.');
    const value = await this.stripe.paymentMethods.retrieve(method, {}, { stripeAccount: account });
    const owner = typeof value.customer === 'string' ? value.customer : value.customer?.id;
    if (!owner) return 'removed' as const; // A customer's subsequent removal takes precedence over redisplay.
    if (owner !== customer) throw new Error('Saved card belongs to another customer.');
    await this.stripe.paymentMethods.update(
      method,
      { allow_redisplay: 'always' },
      { stripeAccount: account, idempotencyKey: key },
    );
    return 'saved' as const;
  }
  async deleteCustomer(account: string, customer: string) {
    this.enabled();
    await this.stripe.customers.del(customer, {}, { stripeAccount: account });
  }
  private mappedSeller(account: Stripe.V2.Core.Account): Seller {
    const merchant = account.configuration?.merchant;
    const responsibilities = account.defaults?.responsibilities;
    return {
      id: account.id,
      charges: merchant?.capabilities?.card_payments?.status === 'active',
      payouts: merchant?.capabilities?.stripe_balance?.payouts?.status === 'active',
      valid:
        account.dashboard === 'full' &&
        responsibilities?.fees_collector === 'stripe' &&
        responsibilities?.losses_collector === 'stripe',
      livemode: account.livemode,
      requirements: account.requirements ?? {},
    };
  }
  async createSeller(
    input: { organizationId: string; name: string; country: string; email: string },
    key: string,
  ) {
    this.enabled();
    return this.mappedSeller(
      await this.stripe.v2.core.accounts.create(
        {
          display_name: input.name,
          contact_email: input.email,
          identity: { country: input.country },
          dashboard: 'full',
          defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
          configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
          metadata: { clubby_organization_id: input.organizationId },
          include: ['configuration.merchant', 'defaults', 'requirements'],
        },
        { idempotencyKey: key },
      ),
    );
  }
  async seller(id: string) {
    this.enabled();
    return this.mappedSeller(
      await this.stripe.v2.core.accounts.retrieve(id, {
        include: ['configuration.merchant', 'defaults', 'requirements'],
      }),
    );
  }
  async onboarding(account: string, origin: string) {
    this.enabled();
    const result = await this.stripe.v2.core.accountLinks.create({
      account,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['merchant'],
          refresh_url: `${origin}/?connect=refresh`,
          return_url: `${origin}/?connect=return`,
        },
      },
    });
    return { url: result.url, expiresAt: result.expires_at };
  }
  private mappedPayment(value: Stripe.PaymentIntent): Payment {
    return {
      id: value.id,
      status: value.status,
      amount: value.amount,
      received: value.amount_received,
      currency: value.currency.toUpperCase(),
      commission: value.application_fee_amount ?? 0,
      orderId: value.metadata.clubby_order_id ?? '',
      attemptId: value.metadata.clubby_attempt_id ?? '',
      clientSecret: value.client_secret,
      chargeId:
        typeof value.latest_charge === 'string' ? value.latest_charge : (value.latest_charge?.id ?? null),
      livemode: value.livemode,
      customerId: typeof value.customer === 'string' ? value.customer : (value.customer?.id ?? null),
      saveForFuture: value.setup_future_usage === 'on_session',
    };
  }
  async createPayment(
    input: {
      orderId: string;
      attemptId: string;
      account: string;
      amount: number;
      commission: number;
      currency: string;
      customerId?: string | null;
      saveCard?: boolean;
    },
    key: string,
  ) {
    this.enabled();
    return this.mappedPayment(
      await this.stripe.paymentIntents.create(
        {
          amount: input.amount,
          currency: input.currency.toLowerCase(),
          application_fee_amount: input.commission,
          payment_method_types: ['card'],
          capture_method: 'automatic',
          ...(input.customerId ? { customer: input.customerId } : {}),
          ...(input.saveCard ? { setup_future_usage: 'on_session' as const } : {}),
          metadata: { clubby_order_id: input.orderId, clubby_attempt_id: input.attemptId },
        },
        { stripeAccount: input.account, idempotencyKey: key },
      ),
    );
  }
  async payment(account: string, id: string) {
    this.enabled();
    return this.mappedPayment(await this.stripe.paymentIntents.retrieve(id, {}, { stripeAccount: account }));
  }
  async cancelPayment(account: string, id: string, key: string) {
    this.enabled();
    return this.mappedPayment(
      await this.stripe.paymentIntents.cancel(id, {}, { stripeAccount: account, idempotencyKey: key }),
    );
  }
  private mappedRefund(value: Stripe.Refund): Refund {
    return {
      id: value.id,
      status: value.status ?? 'pending',
      amount: value.amount,
      currency: value.currency.toUpperCase(),
      paymentId:
        typeof value.payment_intent === 'string' ? value.payment_intent : (value.payment_intent?.id ?? ''),
      refundId: value.metadata?.clubby_refund_id ?? '',
    };
  }
  async createRefund(
    input: {
      account: string;
      paymentId: string;
      amount: number;
      refundId: string;
      refundCommission: boolean;
    },
    key: string,
  ) {
    this.enabled();
    return this.mappedRefund(
      await this.stripe.refunds.create(
        {
          payment_intent: input.paymentId,
          amount: input.amount,
          refund_application_fee: input.refundCommission,
          metadata: { clubby_refund_id: input.refundId },
        },
        { stripeAccount: input.account, idempotencyKey: key },
      ),
    );
  }
  async refund(account: string, id: string) {
    this.enabled();
    return this.mappedRefund(await this.stripe.refunds.retrieve(id, {}, { stripeAccount: account }));
  }
  async refundFee(feeId: string, amount: number, key: string) {
    this.enabled();
    return (await this.stripe.applicationFees.createRefund(feeId, { amount }, { idempotencyKey: key })).id;
  }
  async refunds(account: string, paymentId: string) {
    this.enabled();
    const result: Refund[] = [];
    for await (const value of this.stripe.refunds.list(
      { payment_intent: paymentId, limit: 100 },
      { stripeAccount: account },
    ))
      result.push(this.mappedRefund(value));
    return result;
  }
  async charge(account: string, id: string) {
    this.enabled();
    return this.stripe.charges.retrieve(id, {}, { stripeAccount: account });
  }
  async dispute(account: string, id: string) {
    this.enabled();
    return this.stripe.disputes.retrieve(id, {}, { stripeAccount: account });
  }
  async payout(account: string, id: string) {
    this.enabled();
    return this.stripe.payouts.retrieve(id, {}, account === 'platform' ? {} : { stripeAccount: account });
  }
  async transactions(account: string, after?: string) {
    this.enabled();
    const result = await this.stripe.balanceTransactions.list(
      { limit: 100, ...(after ? { starting_after: after } : {}) },
      account === 'platform' ? {} : { stripeAccount: account },
    );
    return { data: result.data, hasMore: result.has_more };
  }
  async balance(account: string) {
    this.enabled();
    return this.stripe.balance.retrieve({}, account === 'platform' ? {} : { stripeAccount: account });
  }
}
