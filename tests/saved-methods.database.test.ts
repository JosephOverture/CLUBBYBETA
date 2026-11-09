import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { commerceFixture } from './commerce-fixture';
import { OrdersService } from '../apps/api/src/commerce/orders.service';
import { InventoryService } from '../apps/api/src/commerce/inventory.service';
import { SavedMethodsService } from '../apps/api/src/commerce/saved-methods.service';
describe.skipIf(!process.env.TEST_DATABASE_URL)('seller-scoped saved cards and immutable consent', () => {
  let f: Awaited<ReturnType<typeof commerceFixture>>, orders: OrdersService, methods: SavedMethodsService;
  beforeAll(async () => {
    f = await commerceFixture();
    orders = f.app.get(OrdersService);
    methods = f.app.get(SavedMethodsService);
  });
  afterAll(async () => {
    if (f) await f.close();
  });
  async function held(buyer?: Awaited<ReturnType<typeof f.actor>>) {
    const user = buyer ?? (await f.actor()),
      offer = await f.offer(),
      product = await f.app.get(InventoryService).product(f.owner.principal, offer.occurrenceId, {
        name: 'Card fixture',
        priceMinor: 2000,
        taxBps: 2200,
        capacity: 50,
        drinks: 0,
        saleStartsAt: new Date(Date.now() - 60_000).toISOString(),
        saleEndsAt: offer.ends.toISOString(),
        active: true,
      });
    const order = await orders.hold(
      user.principal,
      {
        occurrenceId: offer.occurrenceId,
        email: user.email,
        items: [{ productId: product.data.id, quantity: 1 }],
      },
      randomUUID(),
    );
    return { buyer: user, id: order.data.id };
  }
  async function pay(b: Awaited<ReturnType<typeof held>>, saveCard: boolean) {
    const session = await orders.startPayment(b.buyer.principal, b.id, true, {
      useSavedMethods: true,
      saveCard,
    });
    await orders.applyPayment(f.provider.sellerValue.id, f.provider.succeed(session.data.paymentIntentId));
    const attempt = (await f.db.query('SELECT * FROM payment_attempts WHERE order_id=$1', [b.id])).rows[0]!;
    return { session, attempt };
  }
  it('keeps ordinary checkout free of saved-card customers and only creates saved-card state for verified accounts', async () => {
    const b = await held();
    await orders.startPayment(b.buyer.principal, b.id, true);
    expect(
      (await f.db.query('SELECT id FROM payment_customers WHERE user_id=$1', [b.buyer.principal.userId]))
        .rowCount,
    ).toBe(0);
    const c = await held();
    await expect(
      orders.startPayment({ ...c.buyer.principal, kind: 'guest', email: null }, c.id, true, {
        useSavedMethods: true,
        saveCard: true,
      }),
    ).rejects.toThrow();
    await expect(
      orders.startPayment(c.buyer.principal, c.id, true, { useSavedMethods: false, saveCard: true }),
    ).rejects.toMatchObject({ code: 'SAVED_METHODS_REQUIRED' });
  });
  it('deduplicates provider customer creation after lost responses and shares saved methods across web/native sessions', async () => {
    const b = await held();
    f.provider.failCustomerAfterCommit = true;
    await expect(
      orders.startPayment(b.buyer.principal, b.id, true, { useSavedMethods: true, saveCard: true }),
    ).rejects.toThrow('response loss');
    const results = await Promise.all([
      orders.startPayment(b.buyer.principal, b.id, true, { useSavedMethods: true, saveCard: true }),
      orders.startPayment(b.buyer.principal, b.id, true, { useSavedMethods: true, saveCard: true }),
    ]);
    expect(results[0].data.paymentIntentId).toBe(results[1].data.paymentIntentId);
    expect(results[0].data.customerSessionClientSecret).toContain('_ios_secret');
    const web = await orders.startPayment({ ...b.buyer.principal, channel: 'web' }, b.id, true);
    expect(web.data.customerSessionClientSecret).toContain('_web_secret');
    expect(web.data.customerId).toBe(results[0].data.customerId);
    expect(
      [...f.provider.customers.values()].filter((c) => c.userId === b.buyer.principal.userId),
    ).toHaveLength(1);
    const p = f.provider.succeed(results[0].data.paymentIntentId);
    await orders.applyPayment(f.provider.sellerValue.id, p);
    const attempt = (await f.db.query('SELECT * FROM payment_attempts WHERE order_id=$1', [b.id])).rows[0]!;
    await methods.redisplay(attempt.id);
    await methods.redisplay(attempt.id);
    const account = (await methods.sellers(b.buyer.principal)).data[0]!;
    expect((await methods.list(b.buyer.principal, account.id)).data).toHaveLength(1);
    expect(attempt.card_consent_at).toBeInstanceOf(Date);
    expect(
      (
        await f.db.query("SELECT id FROM outbox_jobs WHERE topic='card.redisplay' AND dedupe_key=$1", [
          attempt.id,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it('locks consent, validates the provider customer, and does not save a new card without consent', async () => {
    const b = await held(),
      session = await orders.startPayment(b.buyer.principal, b.id, true, {
        useSavedMethods: true,
        saveCard: false,
      });
    await expect(
      orders.startPayment(b.buyer.principal, b.id, true, { useSavedMethods: true, saveCard: true }),
    ).rejects.toMatchObject({ code: 'PAYMENT_OPTIONS_LOCKED' });
    const success = f.provider.succeed(session.data.paymentIntentId);
    await expect(
      orders.applyPayment(f.provider.sellerValue.id, { ...success, customerId: 'cus_another' }),
    ).rejects.toThrow('immutable order');
    await orders.applyPayment(f.provider.sellerValue.id, { ...success, saveForFuture: true });
    expect((await orders.view(b.buyer.principal, b.id)).data.status).toBe('paid');
    const attempt = (await f.db.query('SELECT * FROM payment_attempts WHERE order_id=$1', [b.id])).rows[0]!;
    await methods.redisplay(attempt.id);
    expect(attempt.card_save_status).toBe('review');
    expect(
      (await methods.list(b.buyer.principal, (await methods.sellers(b.buyer.principal)).data[0]!.id)).data,
    ).toHaveLength(0);
    await expect(
      f.db.query('UPDATE payment_attempts SET save_card=true,card_consent_at=now() WHERE id=$1', [
        attempt.id,
      ]),
    ).rejects.toThrow('immutable');
  });
  it('prevents cross-customer reads/removal and supports idempotent authenticated deletion', async () => {
    const a = await held(),
      b = await held(),
      paid = await pay(a, true);
    await methods.redisplay(paid.attempt.id);
    await pay(b, false);
    const aAccount = (await methods.sellers(a.buyer.principal)).data[0]!,
      bAccount = (await methods.sellers(b.buyer.principal)).data[0]!,
      card = (await methods.list(a.buyer.principal, aAccount.id)).data[0]!;
    await expect(methods.list(b.buyer.principal, aAccount.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(methods.remove(b.buyer.principal, bAccount.id, { methodId: card.id })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    expect(
      (await f.db.query('SELECT id FROM saved_method_removals WHERE user_id=$1', [b.buyer.principal.userId]))
        .rowCount,
    ).toBe(0);
    await methods.remove(a.buyer.principal, aAccount.id, { methodId: card.id });
    await methods.remove(a.buyer.principal, aAccount.id, { methodId: card.id });
    expect((await methods.list(a.buyer.principal, aAccount.id)).data).toHaveLength(0);
    const response = await f.app.inject({
      method: 'GET',
      url: `/v1/me/payment-accounts/${aAccount.id}/methods`,
      headers: { authorization: `Bearer ${b.buyer.credentials.token}` },
    });
    expect(response.statusCode).toBe(404);
  });
  it('uses a separate customer for each connected account and reconciles creation past the idempotency window', async () => {
    const b = await held(),
      first = await methods.forOrder(b.buyer.principal, b.id),
      second = await methods.customer(b.buyer.principal, 'acct_otherSeller');
    expect(second).not.toBe(first);
    const c = await held();
    f.provider.failCustomerAfterCommit = true;
    await expect(methods.forOrder(c.buyer.principal, c.id)).rejects.toThrow();
    await f.db.query("UPDATE payment_customers SET created_at=now()-interval '2 days' WHERE user_id=$1", [
      c.buyer.principal.userId,
    ]);
    const recovered = await methods.forOrder(c.buyer.principal, c.id);
    expect(recovered).toBe(
      [...f.provider.customers.values()].find((v) => v.userId === c.buyer.principal.userId)!.id,
    );
    const d = await held();
    await f.db.query(
      "INSERT INTO payment_customers(id,user_id,account_id,created_at) VALUES($1,$2,$3,now()-interval '2 days')",
      [randomUUID(), d.buyer.principal.userId, f.provider.sellerValue.id],
    );
    await expect(methods.forOrder(d.buyer.principal, d.id)).rejects.toMatchObject({
      code: 'SAVED_METHODS_REVIEW',
    });
    expect((await orders.startPayment(d.buyer.principal, d.id, true)).data.paymentIntentId).toBeTruthy();
  });
  it('erases saved provider customers and prevents later consent jobs from recreating their card list', async () => {
    const b = await held(),
      paid = await pay(b, true);
    await methods.redisplay(paid.attempt.id);
    await methods.eraseUser(b.buyer.principal.userId);
    await methods.redisplay(paid.attempt.id);
    await methods.eraseUser(b.buyer.principal.userId);
    expect((await methods.sellers(b.buyer.principal)).data).toHaveLength(0);
    expect([...f.provider.customers.values()].some((c) => c.userId === b.buyer.principal.userId)).toBe(false);
    expect([...f.provider.savedCards.values()].some((c) => c.customer === paid.session.data.customerId)).toBe(
      false,
    );
  });
});
