import { describe, it, expect } from 'vitest';
import Stripe from 'stripe';
import { StripeProvider } from '../apps/api/src/commerce/provider';
import { readConfig } from '../apps/api/src/platform/config';
describe('real Stripe SDK request contract with an intercepted transport', () => {
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/test',
    APP_ENCRYPTION_KEY: 'd1'.repeat(32),
    STRIPE_MODE: 'test',
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture',
    STRIPE_WEBHOOK_SECRETS: 'whsec_fixture',
    STRIPE_ONBOARDING_ORIGIN: 'http://localhost:8081',
  });
  function fixture(response: unknown) {
    const requests: { url: string; headers: Headers; body: string }[] = [];
    const transport: typeof fetch = async (url, options) => {
      requests.push({
        url: String(url),
        headers: new Headers(options?.headers),
        body: String(options?.body ?? ''),
      });
      return new Response(JSON.stringify(typeof response === 'function' ? response(String(url)) : response), {
        status: 200,
        headers: { 'content-type': 'application/json', 'request-id': 'req_fixture' },
      });
    };
    return {
      requests,
      provider: new StripeProvider(
        config,
        new Stripe(config.STRIPE_SECRET_KEY!, {
          apiVersion: '2026-08-26.dahlia',
          httpClient: Stripe.createFetchHttpClient(transport),
          maxNetworkRetries: 0,
        }),
      ),
    };
  }
  it('uses connected-account scope, exact minor amounts, stable key and supported card payment method', async () => {
    const response = {
      id: 'pi_fixture',
      status: 'requires_payment_method',
      amount: 1234,
      amount_received: 0,
      currency: 'eur',
      application_fee_amount: 123,
      metadata: { clubby_order_id: 'order', clubby_attempt_id: 'attempt' },
      client_secret: 'pi_fixture_secret_x',
      latest_charge: null,
      livemode: false,
    };
    const f = fixture(response);
    const payment = await f.provider.createPayment(
      {
        orderId: 'order',
        attemptId: 'attempt',
        account: 'acct_seller',
        amount: 1234,
        commission: 123,
        currency: 'EUR',
      },
      'payment-stable',
    );
    const request = f.requests[0]!;
    expect(request.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(request.headers.get('stripe-account')).toBe('acct_seller');
    expect(request.headers.get('idempotency-key')).toBe('payment-stable');
    expect(request.headers.get('stripe-version')).toBe('2026-08-26.dahlia');
    const body = new URLSearchParams(request.body);
    expect(body.get('amount')).toBe('1234');
    expect(body.get('application_fee_amount')).toBe('123');
    expect(body.get('payment_method_types[0]')).toBe('card');
    expect(payment.currency).toBe('EUR');
    await f.provider.payment('acct_seller', 'pi_fixture');
    expect(f.requests[1]!.headers.get('stripe-account')).toBe('acct_seller');
  });
  it('creates merchant accounts with Stripe-managed fees, losses and full seller dashboard', async () => {
    const f = fixture({
      id: 'acct_fixture',
      dashboard: 'full',
      livemode: false,
      defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      configuration: {
        merchant: {
          capabilities: {
            card_payments: { status: 'active' },
            stripe_balance: { payouts: { status: 'active' } },
          },
        },
      },
    });
    const seller = await f.provider.createSeller(
      { organizationId: 'org', name: 'Seller', country: 'IT', email: 'seller@example.test' },
      'seller-stable',
    );
    const body = JSON.parse(f.requests[0]!.body);
    expect(f.requests[0]!.url).toBe('https://api.stripe.com/v2/core/accounts');
    expect(body.configuration.merchant.capabilities.card_payments.requested).toBe(true);
    expect(body.defaults.responsibilities).toEqual({ fees_collector: 'stripe', losses_collector: 'stripe' });
    expect(body.dashboard).toBe('full');
    expect(seller).toMatchObject({ valid: true, charges: true, payouts: true });
  });
  it('scopes saved-card customers and both client session grants to the connected seller', async () => {
    const f = fixture({ id: 'cus_fixture', client_secret: 'cuss_fixture_secret' });
    await f.provider.createCustomer('acct_seller', 'mapping', 'user', 'customer-mapping');
    await f.provider.customerSession('acct_seller', 'cus_fixture', 'web');
    await f.provider.customerSession('acct_seller', 'cus_fixture', 'ios');
    for (const request of f.requests) expect(request.headers.get('stripe-account')).toBe('acct_seller');
    expect(new URLSearchParams(f.requests[0]!.body).get('metadata[clubby_mapping_id]')).toBe('mapping');
    const web = new URLSearchParams(f.requests[1]!.body),
      ios = new URLSearchParams(f.requests[2]!.body);
    expect(web.get('components[payment_element][features][payment_method_save]')).toBe('disabled');
    expect(
      ios.get('components[mobile_payment_element][features][payment_method_allow_redisplay_filters][0]'),
    ).toBe('always');
    expect(ios.get('components[mobile_payment_element][features][payment_method_remove]')).toBe('enabled');
  });
  it('uses on-session consent and validates ownership before redisplay or detachment', async () => {
    const f = fixture((url: string) =>
      url.includes('payment_intents')
        ? {
            id: 'pi_fixture',
            status: 'succeeded',
            amount: 1000,
            amount_received: 1000,
            currency: 'eur',
            application_fee_amount: 100,
            metadata: { clubby_order_id: 'order', clubby_attempt_id: 'attempt' },
            customer: 'cus_fixture',
            payment_method: 'pm_fixture',
            setup_future_usage: 'on_session',
            livemode: false,
          }
        : { id: 'pm_fixture', customer: 'cus_fixture' },
    );
    const payment = await f.provider.createPayment(
      {
        orderId: 'order',
        attemptId: 'attempt',
        account: 'acct_seller',
        amount: 1000,
        commission: 100,
        currency: 'EUR',
        customerId: 'cus_fixture',
        saveCard: true,
      },
      'payment-consent',
    );
    expect(new URLSearchParams(f.requests[0]!.body).get('setup_future_usage')).toBe('on_session');
    expect(payment).toMatchObject({ customerId: 'cus_fixture', saveForFuture: true });
    await f.provider.allowCardRedisplay('acct_seller', 'cus_fixture', 'pi_fixture', 'consent-attempt');
    expect(new URLSearchParams(f.requests.at(-1)!.body).get('allow_redisplay')).toBe('always');
    const length = f.requests.length;
    await expect(
      f.provider.removeCard('acct_seller', 'cus_other', 'pm_fixture', 'remove'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.requests.length).toBe(length + 1);
    await f.provider.removeCard('acct_seller', 'cus_fixture', 'pm_fixture', 'remove');
    expect(f.requests.at(-1)!.url).toBe('https://api.stripe.com/v1/payment_methods/pm_fixture/detach');
    for (const request of f.requests) expect(request.headers.get('stripe-account')).toBe('acct_seller');
  });
  it('refunds connected payments and exact application fees under distinct idempotency keys', async () => {
    const f = fixture({
      id: 're_fixture',
      status: 'pending',
      amount: 100,
      currency: 'eur',
      payment_intent: 'pi_fixture',
      metadata: { clubby_refund_id: 'refund' },
    });
    await f.provider.createRefund(
      {
        account: 'acct_seller',
        paymentId: 'pi_fixture',
        amount: 100,
        refundId: 'refund',
        refundCommission: false,
      },
      'refund-stable',
    );
    expect(f.requests[0]!.headers.get('stripe-account')).toBe('acct_seller');
    expect(new URLSearchParams(f.requests[0]!.body).get('refund_application_fee')).toBe('false');
    await f.provider.refundFee('fee_fixture', 13, 'fee-stable');
    expect(f.requests[1]!.url).toBe('https://api.stripe.com/v1/application_fees/fee_fixture/refunds');
    expect(f.requests[1]!.headers.get('stripe-account')).toBeNull();
    expect(new URLSearchParams(f.requests[1]!.body).get('amount')).toBe('13');
  });
});
