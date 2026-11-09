import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import type { PaymentProvider, Payment, Refund, Seller } from '../apps/api/src/commerce/provider';
// Test-only double. No production route or configuration can construct it.
export class PaymentProviderDouble implements PaymentProvider {
  payments = new Map<string, Payment>();
  paymentKeys = new Map<string, string>();
  refundValues = new Map<string, Refund>();
  refundKeys = new Map<string, string>();
  feeKeys = new Map<string, string>();
  sellerValue: Seller = {
    id: 'acct_clubbyfixture',
    charges: true,
    payouts: true,
    valid: true,
    livemode: false,
    requirements: {},
  };
  failCreateAfterCommit = false;
  failCancel = false;
  refundPending = false;
  customers = new Map<string, { id: string; account: string; userId: string }>();
  savedCards = new Map<
    string,
    {
      customer: string;
      account: string;
      brand: string;
      last4: string;
      expMonth: number;
      expYear: number;
      allowed: boolean;
    }
  >();
  failCustomerAfterCommit = false;
  async createCustomer(account: string, reference: string, userId: string) {
    let value = this.customers.get(reference);
    if (!value) {
      value = { id: `cus_${randomUUID().replaceAll('-', '')}`, account, userId };
      this.customers.set(reference, value);
    }
    if (this.failCustomerAfterCommit) {
      this.failCustomerAfterCommit = false;
      throw new Error('Simulated customer response loss');
    }
    return value.id;
  }
  async findCustomer(account: string, reference: string) {
    const value = this.customers.get(reference);
    return value?.account === account ? value.id : null;
  }
  async customerSession(account: string, customer: string, channel: 'web' | 'ios') {
    if (![...this.customers.values()].some((c) => c.account === account && c.id === customer))
      throw new Error('Wrong customer scope');
    return `cuss_${customer}_${channel}_secret`;
  }
  async cards(account: string, customer: string) {
    return {
      data: [...this.savedCards.entries()]
        .filter(([, m]) => m.account === account && m.customer === customer && m.allowed)
        .map(([id, m]) => ({ id, brand: m.brand, last4: m.last4, expMonth: m.expMonth, expYear: m.expYear })),
      hasMore: false,
    };
  }
  async removeCard(account: string, customer: string, method: string) {
    const value = this.savedCards.get(method);
    if (!value) return;
    if (value.account !== account || value.customer !== customer) throw new Error('Wrong card scope');
    this.savedCards.delete(method);
  }
  async ownsCard(account: string, customer: string, method: string) {
    const c = this.savedCards.get(method);
    return c?.account === account && c.customer === customer;
  }
  async allowCardRedisplay(account: string, customer: string, paymentId: string) {
    const payment = this.payments.get(paymentId)!;
    if (payment.customerId !== customer || !payment.saveForFuture) throw new Error('Wrong card consent');
    this.savedCards.set(`pm_${paymentId.slice(3)}`, {
      account,
      customer,
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      allowed: true,
    });
    return 'saved' as const;
  }
  async deleteCustomer(account: string, customer: string) {
    for (const [id, c] of this.customers)
      if (c.id === customer && c.account === account) this.customers.delete(id);
    for (const [id, c] of this.savedCards)
      if (c.customer === customer && c.account === account) this.savedCards.delete(id);
  }
  async createSeller() {
    return this.sellerValue;
  }
  async seller() {
    return this.sellerValue;
  }
  async onboarding() {
    return {
      url: 'https://connect.stripe.com/setup/fixture',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }
  async createPayment(input: Parameters<PaymentProvider['createPayment']>[0], key: string) {
    let id = this.paymentKeys.get(key);
    if (!id) {
      id = `pi_${randomUUID().replaceAll('-', '')}`;
      this.paymentKeys.set(key, id);
      this.payments.set(id, {
        id,
        status: 'requires_payment_method',
        amount: input.amount,
        received: 0,
        currency: input.currency,
        commission: input.commission,
        orderId: input.orderId,
        attemptId: input.attemptId,
        clientSecret: `${id}_secret_fixture`,
        chargeId: `ch_${id}`,
        livemode: false,
        customerId: input.customerId ?? null,
        saveForFuture: input.saveCard ?? false,
      });
    }
    if (this.failCreateAfterCommit) {
      this.failCreateAfterCommit = false;
      throw new Error('Simulated connection loss after provider committed');
    }
    return { ...this.payments.get(id)! };
  }
  async payment(_account: string, id: string) {
    const value = this.payments.get(id);
    if (!value) throw new Error('Unknown provider payment');
    return { ...value };
  }
  async cancelPayment(account: string, id: string) {
    if (this.failCancel) throw new Error('Simulated provider outage');
    const value = await this.payment(account, id);
    if (value.status === 'succeeded') throw new Error('Already captured');
    value.status = 'canceled';
    this.payments.set(id, value);
    return value;
  }
  succeed(id: string) {
    const value = this.payments.get(id)!;
    value.status = 'succeeded';
    value.received = value.amount;
    return { ...value };
  }
  async createRefund(input: Parameters<PaymentProvider['createRefund']>[0], key: string) {
    let id = this.refundKeys.get(key);
    if (!id) {
      id = `re_${randomUUID().replaceAll('-', '')}`;
      this.refundKeys.set(key, id);
      this.refundValues.set(id, {
        id,
        status: this.refundPending ? 'pending' : 'succeeded',
        amount: input.amount,
        paymentId: input.paymentId,
        refundId: input.refundId,
        currency: this.payments.get(input.paymentId)!.currency,
      });
    }
    return { ...this.refundValues.get(id)! };
  }
  async refund(_account: string, id: string) {
    return { ...this.refundValues.get(id)! };
  }
  async refunds(_account: string, paymentId: string) {
    return [...this.refundValues.values()].filter((v) => v.paymentId === paymentId);
  }
  async refundFee(_feeId: string, _amount: number, key: string) {
    let id = this.feeKeys.get(key);
    if (!id) {
      id = `fr_${randomUUID()}`;
      this.feeKeys.set(key, id);
    }
    return id;
  }
  async charge(_account: string, id: string) {
    return {
      id,
      application_fee: `fee_${id}`,
      payment_intent: id.replace(/^ch_/, ''),
      refunded: false,
      amount_refunded: 0,
    } as Stripe.Charge;
  }
  async dispute() {
    throw new Error('Dispute fixture must be supplied');
    return {} as Stripe.Dispute;
  }
  async payout() {
    throw new Error('Payout fixture must be supplied');
    return {} as Stripe.Payout;
  }
  async transactions() {
    return { data: [] as Stripe.BalanceTransaction[], hasMore: false };
  }
  async balance() {
    return { available: [], pending: [] } as unknown as Stripe.Balance;
  }
}
