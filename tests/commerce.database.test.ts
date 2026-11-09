import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import type { FastifyRequest } from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { isolatedDatabase } from './database-helper';
import { PaymentProviderDouble } from './payment-provider-double';
import { Database } from '../apps/api/src/platform/database';
import { migrate } from '../apps/api/src/platform/migrations';
import { createApplication } from '../apps/api/src/bootstrap';
import { IdentityService, type Principal } from '../apps/api/src/identity/identity.service';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
import { OrdersService } from '../apps/api/src/commerce/orders.service';
import { InventoryService } from '../apps/api/src/commerce/inventory.service';
import { SellersService } from '../apps/api/src/commerce/sellers.service';
import { PaymentsService } from '../apps/api/src/commerce/payments.service';
import { RefundsService } from '../apps/api/src/commerce/refunds.service';
import { AdmissionsService } from '../apps/api/src/commerce/admissions.service';
import { BookingSupportService } from '../apps/api/src/commerce/support.service';
import { activateTestMarket } from './market-fixture';
import { EventsService } from '../apps/api/src/events/events.service';
import { journal } from '../apps/api/src/commerce/core';
import { hash } from '../apps/api/src/platform/crypto';
import { PrivacyService } from '../apps/api/src/privacy/privacy.service';
import { BillingService } from '../apps/api/src/commerce/billing.service';
import type StripeTypes from 'stripe';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'ticket commerce with real PostgreSQL and verified provider boundaries',
  () => {
    let db: Database,
      dispose: () => Promise<void>,
      app: NestFastifyApplication,
      owner: Principal,
      admin: Principal,
      org: string,
      orders: OrdersService,
      inventory: InventoryService,
      sellers: SellersService,
      payments: PaymentsService,
      refunds: RefundsService,
      admissions: AdmissionsService,
      support: BookingSupportService;
    const provider = new PaymentProviderDouble();
    const signing = 'whsec_clubbytest';
    async function actor(
      kind: 'guest' | 'registered' = 'registered',
      email = `${randomUUID()}@example.test`,
    ) {
      const id = randomUUID();
      await db.query('INSERT INTO users(id,email,email_verified_at,kind) VALUES($1,$2,$3,$4)', [
        id,
        kind === 'guest' ? null : email,
        kind === 'guest' ? null : new Date(),
        kind,
      ]);
      const identity = app.get(IdentityService);
      const credentials = await db.transaction((tx) => identity.issue(tx, id, 'ios'));
      return {
        principal: await identity.authenticate({
          method: 'GET',
          headers: { authorization: `Bearer ${credentials.token}` },
          cookies: {},
        } as FastifyRequest),
        token: credentials.token,
        email,
      };
    }
    async function occurrence(capacity = 100, price = 2500, drinks = 1) {
      const eventId = randomUUID(),
        id = randomUUID();
      await db.query(
        "INSERT INTO events(id,venue_id,organization_id,title,status) VALUES($1,'commerce-club',$2,'Commerce fixture','published')",
        [eventId, org],
      );
      await db.query(
        "INSERT INTO occurrences(id,event_id,starts_at,ends_at,timezone,currency,capacity,status) VALUES($1,$2,now()+interval '2 hours',now()+interval '6 hours','Europe/Rome','EUR',$3,'published')",
        [id, eventId, capacity],
      );
      const product = await inventory.product(owner, id, {
        name: 'Standard admission',
        priceMinor: price,
        taxBps: 2200,
        capacity,
        drinks,
        saleStartsAt: new Date(Date.now() - 3600_000).toISOString(),
        saleEndsAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
        active: true,
      });
      return { id, eventId, productId: product.data!.id as string };
    }
    async function purchase(qty = 1, price = 2500) {
      const buyer = await actor();
      const event = await occurrence(100, price);
      const held = await orders.hold(
        buyer.principal,
        {
          occurrenceId: event.id,
          items: [{ productId: event.productId, quantity: qty }],
          email: buyer.email,
        },
        randomUUID(),
      );
      const started = await orders.startPayment(buyer.principal, held.data.id, true);
      if ('paymentIntentId' in started.data)
        await orders.applyPayment(provider.sellerValue.id, provider.succeed(started.data.paymentIntentId));
      const view = await orders.view(buyer.principal, held.data.id);
      return { buyer, event, held, started, view };
    }
    beforeAll(async () => {
      ({ db, dispose } = await isolatedDatabase({
        APP_ENCRYPTION_KEY: 'd1'.repeat(32),
        EMAIL_MODE: 'file',
        STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_fixture',
        STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture',
        STRIPE_WEBHOOK_SECRETS: signing,
        STRIPE_ONBOARDING_ORIGIN: 'http://localhost:8081',
      }));
      await migrate(db, resolve('database/migrations'));
      app = await createApplication(db.config, db, { paymentProvider: provider });
      orders = app.get(OrdersService);
      inventory = app.get(InventoryService);
      sellers = app.get(SellersService);
      payments = app.get(PaymentsService);
      refunds = app.get(RefundsService);
      admissions = app.get(AdmissionsService);
      support = app.get(BookingSupportService);
      ({ principal: owner } = await actor());
      ({ principal: admin } = await actor());
      await db.query("INSERT INTO platform_grants(user_id,role) VALUES($1,'admin')", [admin.userId]);
      const organizations = app.get(OrganizationsService);
      org = (
        await organizations.apply(owner, {
          name: 'Commerce seller',
          legalName: 'Fixture seller company',
          countryCode: 'IT',
        })
      ).data.id;
      await organizations.review(admin, org, {
        status: 'approved',
        expectedVersion: 1,
        reason: 'Test seller approval',
      });
      await db.query(
        "INSERT INTO destinations(id,name,country_code,timezone,currency,published,native_sales_enabled) VALUES('milan','Milan','IT','Europe/Rome','EUR',true,true)",
      );
      await db.query(
        "INSERT INTO venues(id,destination_id,name,status,organization_id,commercial_mode) VALUES('commerce-club','milan','Commerce Club','published',$1,'native')",
        [org],
      );
      await db.query('UPDATE public_settings SET new_sales_paused=false');
      const policy = await sellers.policy(admin, org, {
        commissionBps: 1250,
        refundCutoffHours: 0,
        refundCommission: true,
        terms: 'Development-only commercial terms for tests; never production acceptance.',
        taxRegistration: 'IT-FIXTURE',
        processingFeeBearer: 'seller',
        payoutModel: 'stripe-managed',
        reason: 'Explicit local test policy',
      });
      await sellers.accept(owner, org, policy.data.id);
      await sellers.onboard(owner, org);
      await activateTestMarket(db, admin, sellers);
    });
    afterAll(async () => {
      if (app) await app.close();
      else if (db) await db.onApplicationShutdown();
      if (dispose) await dispose();
    });
    it('prevents overselling the last seat under simultaneous buyers', async () => {
      const event = await occurrence(1);
      const buyers = await Promise.all(Array.from({ length: 12 }, () => actor()));
      const results = await Promise.allSettled(
        buyers.map((buyer) =>
          orders.hold(
            buyer.principal,
            {
              occurrenceId: event.id,
              items: [{ productId: event.productId, quantity: 1 }],
              email: buyer.email,
            },
            randomUUID(),
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        results
          .filter((r) => r.status === 'rejected')
          .every((r) => (r as PromiseRejectedResult).reason.code === 'SOLD_OUT'),
      ).toBe(true);
      expect((await inventory.offers(event.id)).data[0]!.available).toBe(0);
    });
    it('enforces event capacity across different price tiers', async () => {
      const event = await occurrence(1);
      const other = await inventory.product(owner, event.id, {
        name: 'Second tier',
        priceMinor: 3500,
        taxBps: 2200,
        capacity: 1,
        drinks: 0,
        saleStartsAt: new Date(Date.now() - 3600_000).toISOString(),
        saleEndsAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
        active: true,
      });
      const buyers = await Promise.all([actor(), actor()]);
      const results = await Promise.allSettled(
        [event.productId, other.data!.id].map((id, index) =>
          orders.hold(
            buyers[index]!.principal,
            { occurrenceId: event.id, items: [{ productId: id, quantity: 1 }], email: buyers[index]!.email },
            randomUUID(),
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });
    it('deduplicates checkout retries, detects changed input and ignores client price fields', async () => {
      const event = await occurrence(),
        buyer = await actor(),
        key = randomUUID();
      const input = {
        occurrenceId: event.id,
        items: [{ productId: event.productId, quantity: 2 }],
        email: buyer.email,
      };
      const result = await Promise.all([
        orders.hold(buyer.principal, input, key),
        orders.hold(buyer.principal, input, key),
      ]);
      expect(result[0]).toEqual(result[1]);
      expect(result[0]!.data.totalMinor).toBe(5000);
      await expect(
        orders.hold(buyer.principal, { ...input, items: [{ productId: event.productId, quantity: 3 }] }, key),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      await expect(orders.hold(buyer.principal, { ...input, totalMinor: 1 }, randomUUID())).rejects.toThrow();
    });
    it('reserves promotion usage atomically and snapshots integer totals/tax', async () => {
      const event = await occurrence(20, 1001);
      const code = `P${randomUUID().replaceAll('-', '')}`.toUpperCase();
      await inventory.promotion(owner, org, {
        code,
        discountBps: 3333,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        occurrenceId: event.id,
      });
      const buyers = await Promise.all([actor(), actor()]);
      const results = await Promise.allSettled(
        buyers.map((b) =>
          orders.hold(
            b.principal,
            {
              occurrenceId: event.id,
              items: [{ productId: event.productId, quantity: 3 }],
              email: b.email,
              promotionCode: code,
            },
            randomUUID(),
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const success = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>;
      expect(success.value.data.totalMinor).toBe(2003);
      expect(success.value.data.taxMinor).toBe(361);
    });
    it('recovers a connection loss after payment creation without creating a second intent', async () => {
      const buyer = await actor(),
        event = await occurrence();
      const held = await orders.hold(
        buyer.principal,
        { occurrenceId: event.id, items: [{ productId: event.productId, quantity: 1 }], email: buyer.email },
        randomUUID(),
      );
      const before = provider.paymentKeys.size;
      provider.failCreateAfterCommit = true;
      await expect(orders.startPayment(buyer.principal, held.data.id, true)).rejects.toThrow(
        'connection loss',
      );
      const retried = await Promise.all([
        orders.startPayment(buyer.principal, held.data.id, true),
        orders.startPayment(buyer.principal, held.data.id, true),
      ]);
      expect(retried[0].data).toEqual(retried[1].data);
      expect(provider.paymentKeys.size).toBe(before + 1);
    });
    it('fulfills one credential per admission and is stable under duplicate/out-of-order callbacks', async () => {
      const result = await purchase(3);
      const payment = provider.payments.get(result.started.data.paymentIntentId)!;
      await Promise.all([
        orders.applyPayment(provider.sellerValue.id, { ...payment }),
        orders.applyPayment(provider.sellerValue.id, {
          ...payment,
          status: 'requires_payment_method',
          received: 0,
        }),
      ]);
      const tickets = (await orders.view(result.buyer.principal, result.held.data.id)).data.tickets;
      expect(tickets).toHaveLength(3);
      const credentials = await Promise.all(
        tickets.map((t) => admissions.ticket(result.buyer.principal, t.id)),
      );
      expect(new Set(credentials.map((t) => t.data.credential)).size).toBe(3);
      expect(
        (
          await db.query('SELECT reference FROM ledger_journals WHERE reference=$1', [
            `sale:${result.held.data.id}`,
          ])
        ).rowCount,
      ).toBe(1);
      expect(
        (await db.query('SELECT status FROM payment_attempts WHERE order_id=$1', [result.held.data.id]))
          .rows[0]!.status,
      ).toBe('succeeded');
    });
    it('rejects forged amount, currency, account and environment results', async () => {
      const result = await purchase();
      const payment = provider.payments.get(result.started.data.paymentIntentId)!;
      for (const extra of [{ amount: 1 }, { currency: 'USD' }, { commission: 1 }, { livemode: true }])
        await expect(orders.applyPayment(provider.sellerValue.id, { ...payment, ...extra })).rejects.toThrow(
          'immutable order',
        );
      await orders.applyPayment('acct_unknown', { ...payment });
      expect((await orders.view(result.buyer.principal, result.held.data.id)).data.status).toBe('paid');
    });
    it('holds stock during uncertain cancellation and releases only after provider cancellation', async () => {
      const buyer = await actor(),
        event = await occurrence(1);
      const held = await orders.hold(
        buyer.principal,
        { occurrenceId: event.id, items: [{ productId: event.productId, quantity: 1 }], email: buyer.email },
        randomUUID(),
      );
      await orders.startPayment(buyer.principal, held.data.id, true);
      await orders.cancel(buyer.principal, held.data.id);
      provider.failCancel = true;
      await expect(orders.expire(held.data.id)).rejects.toThrow('unresolved');
      expect((await inventory.offers(event.id)).data[0]!.available).toBe(0);
      provider.failCancel = false;
      await orders.expire(held.data.id);
      expect((await inventory.offers(event.id)).data[0]!.available).toBe(1);
    });
    it('uses one free-order fulfillment and releases expired untouched holds', async () => {
      const free = await purchase(2, 0);
      expect(free.view.data.status).toBe('paid');
      expect(free.view.data.tickets).toHaveLength(2);
      expect(
        (await db.query('SELECT id FROM payment_attempts WHERE order_id=$1', [free.held.data.id])).rowCount,
      ).toBe(0);
      const buyer = await actor(),
        event = await occurrence(1);
      const held = await orders.hold(
        buyer.principal,
        { occurrenceId: event.id, items: [{ productId: event.productId, quantity: 1 }], email: buyer.email },
        randomUUID(),
      );
      await db.query("UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=$1", [held.data.id]);
      await orders.expire(held.data.id);
      expect((await inventory.offers(event.id)).data[0]!.available).toBe(1);
    });
    it('claims guest orders only with the verified checkout email and isolates private bookings', async () => {
      const guest = await actor('guest'),
        event = await occurrence();
      const held = await orders.hold(
        guest.principal,
        { occurrenceId: event.id, items: [{ productId: event.productId, quantity: 1 }], email: guest.email },
        randomUUID(),
      );
      await orders.startPayment(guest.principal, held.data.id, true);
      const payment = [...provider.payments.values()].find((p) => p.orderId === held.data.id)!;
      await orders.applyPayment(provider.sellerValue.id, provider.succeed(payment.id));
      const wrong = await actor();
      await expect(orders.claim(wrong.principal, held.data.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const verified = await actor('registered', guest.email);
      await orders.claim(verified.principal, held.data.id);
      await expect(orders.view(guest.principal, held.data.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await orders.view(verified.principal, held.data.id)).data.tickets[0]!.ownerId).toBe(
        verified.principal.userId,
      );
    });
    it('checks admission once under concurrent scans, retries safely and accounts drinks separately', async () => {
      const result = await purchase();
      const ticket = await admissions.ticket(result.buyer.principal, result.view.data.tickets[0]!.id);
      const input = { occurrenceId: result.event.id, credential: ticket.data.credential, kind: 'admission' };
      const results = await Promise.all([
        admissions.scan(owner, input, randomUUID()),
        admissions.scan(owner, input, randomUUID()),
      ]);
      expect(results.map((r) => r.data.outcome).sort()).toEqual(['accepted', 'already-admitted']);
      const key = randomUUID();
      const first = await admissions.scan(owner, { ...input, kind: 'drink' }, key);
      expect(first.data.outcome).toBe('accepted');
      expect(await admissions.scan(owner, { ...input, kind: 'drink' }, key)).toEqual(first);
      expect((await admissions.scan(owner, { ...input, kind: 'drink' }, randomUUID())).data.outcome).toBe(
        'drinks-exhausted',
      );
      await expect(admissions.scan(result.buyer.principal, input, randomUUID())).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
    it('serializes refund against admission and invalidates pending/refunded credentials', async () => {
      const result = await purchase(2);
      const ticket = await admissions.ticket(result.buyer.principal, result.view.data.tickets[0]!.id);
      const responses = await Promise.allSettled([
        refunds.request(
          result.buyer.principal,
          result.held.data.id,
          { ticketIds: [ticket.data.id], reason: 'Customer requests this admission refund' },
          randomUUID(),
        ),
        admissions.scan(
          owner,
          { occurrenceId: result.event.id, credential: ticket.data.credential, kind: 'admission' },
          randomUUID(),
        ),
      ]);
      const refunded = responses[0];
      if (refunded.status === 'fulfilled') {
        expect((responses[1] as PromiseFulfilledResult<any>).value.data.outcome).toBe('inactive');
        await refunds.process(refunded.value.data.id);
        expect((await admissions.ticket(result.buyer.principal, ticket.data.id)).data.status).toBe(
          'refunded',
        );
      } else expect(refunded.reason.code).toBe('TICKET_NOT_REFUNDABLE');
    });
    it('confirms partial refunds only after provider success and reverses exact fee allocation once', async () => {
      const result = await purchase(3, 1001);
      const target = result.view.data.tickets[0]!.id;
      const refund = await refunds.request(
        result.buyer.principal,
        result.held.data.id,
        { ticketIds: [target], reason: 'Customer partial refund request' },
        randomUUID(),
      );
      provider.refundPending = true;
      await refunds.process(refund.data.id);
      expect((await orders.view(result.buyer.principal, result.held.data.id)).data.status).toBe(
        'refund-pending',
      );
      const value = [...provider.refundValues.values()].find((r) => r.refundId === refund.data.id)!;
      value.status = 'succeeded';
      provider.refundPending = false;
      await Promise.all([refunds.process(refund.data.id), refunds.process(refund.data.id)]);
      expect((await orders.view(result.buyer.principal, result.held.data.id)).data.status).toBe(
        'partially-refunded',
      );
      await Promise.all([refunds.refundFee(refund.data.id), refunds.refundFee(refund.data.id)]);
      expect([...provider.feeKeys.keys()].filter((k) => k === `fee-refund-${refund.data.id}`)).toHaveLength(
        1,
      );
      expect((await inventory.offers(result.event.id)).data[0]!.available).toBe(98);
    });
    it('verifies exact HTTP webhook bytes and freshness, deduplicates and fetches authoritative state', async () => {
      const result = await purchase();
      const id = `evt_${randomUUID()}`;
      const body = JSON.stringify({
        id,
        type: 'payment_intent.succeeded',
        livemode: false,
        account: provider.sellerValue.id,
        data: { object: { id: result.started.data.paymentIntentId, amount: 1 } },
      });
      const stripe = new Stripe('sk_test_signature');
      const signature = stripe.webhooks.generateTestHeaderString({ payload: body, secret: signing });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            payload: body,
            headers: { 'content-type': 'application/json', 'stripe-signature': signature },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            payload: body + ' ',
            headers: { 'content-type': 'application/json', 'stripe-signature': signature },
          })
        ).statusCode,
      ).toBe(400);
      const stale = stripe.webhooks.generateTestHeaderString({
        payload: body,
        secret: signing,
        timestamp: Math.floor(Date.now() / 1000) - 600,
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/webhooks/stripe',
            payload: body,
            headers: { 'content-type': 'application/json', 'stripe-signature': stale },
          })
        ).statusCode,
      ).toBe(400);
      await payments.webhook(Buffer.from(body), signature);
      await payments.event(id);
      expect((await db.query('SELECT event_id FROM provider_inbox WHERE event_id=$1', [id])).rowCount).toBe(
        1,
      );
      expect((await orders.view(result.buyer.principal, result.held.data.id)).data.status).toBe('paid');
    });
    it('cancellation queues refunds and blocks admission immediately even before workers run', async () => {
      const result = await purchase();
      await app.get(EventsService).changeOccurrence(owner, result.event.id, {
        action: 'cancel',
        expectedVersion: 1,
        reason: 'Venue cancelled the event',
      });
      const ticket = await admissions.ticket(result.buyer.principal, result.view.data.tickets[0]!.id);
      expect(ticket.data.credential).toBeNull();
      const change = (
        await db.query('SELECT id FROM catalogue_changes WHERE aggregate_id=$1', [result.event.id])
      ).rows[0]!;
      await db.transaction((tx) => payments.catalogueChanged(tx, { changeId: change.id }, randomUUID()));
      await refunds.compensate(result.held.data.id);
      const refund = (await db.query('SELECT id FROM refunds WHERE order_id=$1', [result.held.data.id]))
        .rows[0]!;
      await refunds.process(refund.id);
      expect((await orders.view(result.buyer.principal, result.held.data.id)).data.status).toBe('refunded');
    });
    it('forces review of dashboard refunds and supports explicit ticket allocation', async () => {
      const result = await purchase();
      const value = {
        id: `re_${randomUUID().replaceAll('-', '')}`,
        status: 'succeeded',
        amount: 2500,
        paymentId: result.started.data.paymentIntentId,
        refundId: '',
        currency: 'EUR',
      };
      provider.refundValues.set(value.id, value);
      await payments.observedRefund(provider.sellerValue.id, value);
      expect((await orders.view(result.buyer.principal, result.held.data.id)).data.status).toBe('review');
      expect(
        (await admissions.ticket(result.buyer.principal, result.view.data.tickets[0]!.id)).data.credential,
      ).toBeNull();
      const allocated = await support.allocateExternalRefund(owner, value.id, {
        ticketIds: [result.view.data.tickets[0]!.id],
        reason: 'Verified admission covered by the Stripe dashboard refund',
      });
      await refunds.process(allocated.data.refundId);
      expect((await orders.view(result.buyer.principal, result.held.data.id)).data.status).toBe('refunded');
    });
    it('enforces append-only balanced journals at the database boundary', async () => {
      await expect(
        db.query(
          "INSERT INTO ledger_journals(id,reference,book,currency,description) VALUES($1,$2,'commerce','EUR','Unbalanced test')",
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toThrow('balanced');
      await expect(
        db.query('UPDATE ledger_postings SET amount_minor=1 WHERE id=(SELECT min(id) FROM ledger_postings)'),
      ).rejects.toThrow('append-only');
      await expect(
        db.transaction((tx) => journal(tx, randomUUID(), 'EUR', null, 'Invalid sum', { a: 2, b: -1 })),
      ).rejects.toThrow('Unbalanced');
      expect(
        (
          await db.query(
            'SELECT journal_id FROM ledger_postings GROUP BY journal_id HAVING sum(amount_minor)<>0',
          )
        ).rowCount,
      ).toBe(0);
    });
    it('scopes support and finance access and exposes protected routes in OpenAPI', async () => {
      const result = await purchase();
      const created = await support.create(
        result.buyer.principal,
        result.held.data.id,
        { subject: 'Booking question', message: 'Please clarify the arrival time for this booking.' },
        randomUUID(),
      );
      await expect(support.view((await actor()).principal, created.data.id)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect((await support.view(owner, created.data.id)).data.messages).toHaveLength(1);
      await support.reply(
        owner,
        created.data.id,
        { message: 'Doors open at the published time.', status: 'resolved', expectedVersion: 1 },
        randomUUID(),
      );
      await expect(support.finance(result.buyer.principal, org)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await support.finance(owner, org)).data.totals.length).toBeGreaterThan(0);
      const docs = (await app.inject('/v1/openapi.json')).json();
      expect(docs.paths['/v1/orders'].post.security).toBeDefined();
      expect((await app.inject({ method: 'POST', url: '/v1/orders', payload: {} })).statusCode).toBe(401);
    });
    it('quotes without allocating inventory or leaving orders and records accepted terms before payment', async () => {
      const buyer = await actor(),
        event = await occurrence(2);
      const input = {
        occurrenceId: event.id,
        items: [{ productId: event.productId, quantity: 1 }],
        email: buyer.email,
      };
      const quote = await orders.quote(buyer.principal, input);
      expect(quote.data.reserved).toBe(false);
      expect(
        (await db.query('SELECT id FROM orders WHERE user_id=$1', [buyer.principal.userId])).rowCount,
      ).toBe(0);
      expect((await inventory.offers(event.id)).data[0]!.available).toBe(2);
      const held = await orders.hold(buyer.principal, input, randomUUID());
      expect(held.data.totalMinor).toBe(quote.data.totalMinor);
      await expect(orders.startPayment(buyer.principal, held.data.id)).rejects.toMatchObject({
        code: 'TERMS_REQUIRED',
      });
      await orders.startPayment(buyer.principal, held.data.id, true);
      expect(
        (await db.query('SELECT buyer_accepted_at FROM orders WHERE id=$1', [held.data.id])).rows[0]!
          .buyer_accepted_at,
      ).toBeTruthy();
    });
    it('never lifts financial review on a replay of the original successful payment', async () => {
      const result = await purchase();
      const value = {
        id: `re_${randomUUID().replaceAll('-', '')}`,
        status: 'succeeded',
        amount: 100,
        paymentId: result.started.data.paymentIntentId,
        refundId: '',
        currency: 'EUR',
      };
      await payments.observedRefund(provider.sellerValue.id, value);
      await orders.applyPayment(provider.sellerValue.id, provider.payments.get(value.paymentId)!);
      expect((await orders.view(result.buyer.principal, result.held.data.id)).data.status).toBe('review');
      expect(
        (await admissions.ticket(result.buyer.principal, result.view.data.tickets[0]!.id)).data.credential,
      ).toBeNull();
    });
    it('coordinates staff blocks and refuses reductions below commitments', async () => {
      const event = await occurrence(3);
      const blocked = await inventory.block(owner, event.id, {
        quantity: 2,
        reason: 'Reserved for venue guest list',
      });
      expect((await inventory.offers(event.id)).data[0]!.available).toBe(1);
      const buyer = await actor();
      await orders.hold(
        buyer.principal,
        { occurrenceId: event.id, items: [{ productId: event.productId, quantity: 1 }], email: buyer.email },
        randomUUID(),
      );
      await expect(
        inventory.capacity(owner, event.id, {
          capacity: 2,
          expectedVersion: 1,
          reason: 'Reduce room operating capacity',
        }),
      ).rejects.toMatchObject({ code: 'CAPACITY_COMMITTED' });
      await inventory.block(owner, event.id, {
        quantity: 2,
        releaseId: blocked.data.id,
        reason: 'Guest list allocation released',
      });
      expect((await inventory.offers(event.id)).data[0]!.available).toBe(2);
    });
    it('does not reprice purchased lines when a tier changes and seals posted journals', async () => {
      const result = await purchase(1, 2500);
      await inventory.product(
        owner,
        result.event.id,
        {
          name: 'New price',
          priceMinor: 9900,
          taxBps: 2200,
          capacity: 100,
          drinks: 2,
          saleStartsAt: new Date(Date.now() - 3600_000).toISOString(),
          saleEndsAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
          active: true,
          expectedVersion: 1,
        },
        result.event.productId,
      );
      expect((await orders.view(result.buyer.principal, result.held.data.id)).data.totalMinor).toBe(2500);
      await expect(
        db.query('UPDATE orders SET total_minor=1 WHERE id=$1', [result.held.data.id]),
      ).rejects.toThrow('immutable');
      const ledger = (
        await db.query('SELECT id FROM ledger_journals WHERE order_id=$1', [result.held.data.id])
      ).rows[0]!;
      await expect(
        db.query('INSERT INTO ledger_postings(journal_id,account,amount_minor) VALUES($1,$2,1)', [
          ledger.id,
          'forged',
        ]),
      ).rejects.toThrow('sealed');
    });
    it('resumes the same native order through an authenticated web cookie without a second charge', async () => {
      const buyer = await actor(),
        event = await occurrence();
      const held = await orders.hold(
        buyer.principal,
        { occurrenceId: event.id, items: [{ productId: event.productId, quantity: 1 }], email: buyer.email },
        randomUUID(),
      );
      const ios = await orders.startPayment(buyer.principal, held.data.id, true);
      const web = await db.transaction((tx) =>
        app.get(IdentityService).issue(tx, buyer.principal.userId, 'web'),
      );
      const response = await app.inject({
        method: 'POST',
        url: `/v1/orders/${held.data.id}/payment`,
        headers: {
          cookie: `clubby_session=${web.token}`,
          origin: 'http://localhost:8081',
          'x-csrf-token': web.csrfToken,
        },
        payload: { acceptTerms: true },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.paymentIntentId).toBe(ios.data.paymentIntentId);
      expect(
        (await db.query('SELECT id FROM payment_attempts WHERE order_id=$1', [held.data.id])).rowCount,
      ).toBe(1);
    });
    it('compensates a payment that succeeds while cancellation is in progress', async () => {
      const buyer = await actor(),
        event = await occurrence(1);
      const held = await orders.hold(
        buyer.principal,
        { occurrenceId: event.id, items: [{ productId: event.productId, quantity: 1 }], email: buyer.email },
        randomUUID(),
      );
      const started = await orders.startPayment(buyer.principal, held.data.id, true);
      await orders.cancel(buyer.principal, held.data.id);
      provider.succeed(started.data.paymentIntentId);
      await orders.expire(held.data.id);
      const ticket = (await orders.view(buyer.principal, held.data.id)).data.tickets[0]!;
      expect((await admissions.ticket(buyer.principal, ticket.id)).data.credential).toBeNull();
      await refunds.compensate(held.data.id);
      const refund = (await db.query('SELECT id FROM refunds WHERE order_id=$1', [held.data.id])).rows[0]!;
      await refunds.process(refund.id);
      expect((await inventory.offers(event.id)).data[0]!.available).toBe(1);
    });
    it('reports ledger/provider reconciliation differences without inventing corrections', async () => {
      const originalTransactions = provider.transactions,
        originalBalance = provider.balance;
      const transaction = {
        id: `txn_${randomUUID()}`,
        amount: 10000,
        fee: 500,
        net: 9500,
        currency: 'eur',
        source: 'ch_external',
        type: 'charge',
        created: Math.floor(Date.now() / 1000),
        available_on: Math.floor(Date.now() / 1000),
      } as StripeTypes.BalanceTransaction;
      provider.transactions = async () => ({ data: [transaction], hasMore: false });
      provider.balance = async () =>
        ({ available: [{ currency: 'eur', amount: 9500 }], pending: [] }) as unknown as StripeTypes.Balance;
      try {
        await payments.reconcile(provider.sellerValue.id);
        expect(
          (
            await db.query(
              'SELECT status FROM reconciliation_runs WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1',
              [provider.sellerValue.id],
            )
          ).rows[0]!.status,
        ).toBe('matched');
        provider.balance = async () =>
          ({ available: [{ currency: 'eur', amount: 9000 }], pending: [] }) as unknown as StripeTypes.Balance;
        await payments.reconcile(provider.sellerValue.id);
        expect(
          (
            await db.query(
              'SELECT status FROM reconciliation_runs WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1',
              [provider.sellerValue.id],
            )
          ).rows[0]!.status,
        ).toBe('review');
        expect(
          (
            await db.query('SELECT provider_id FROM provider_balance_transactions WHERE provider_id=$1', [
              transaction.id,
            ])
          ).rowCount,
        ).toBe(1);
      } finally {
        provider.transactions = originalTransactions;
        provider.balance = originalBalance;
      }
    });
    it('handles non-Clubby connected-account payments and balance webhooks without invalid identifiers', async () => {
      await orders.applyPayment(provider.sellerValue.id, {
        id: 'pi_unrelated',
        status: 'succeeded',
        amount: 200,
        received: 200,
        currency: 'EUR',
        commission: 0,
        orderId: '',
        attemptId: '',
        clientSecret: null,
        chargeId: null,
        livemode: false,
      });
      const body = JSON.stringify({
        id: `evt_${randomUUID()}`,
        type: 'balance.available',
        livemode: false,
        data: { object: { object: 'balance', available: [] } },
      });
      const stripe = new Stripe('sk_test_signature');
      expect(
        await payments.webhook(
          Buffer.from(body),
          stripe.webhooks.generateTestHeaderString({ payload: body, secret: signing }),
        ),
      ).toEqual({ received: true });
    });
    it('prices bounded drink add-ons on the server and attaches them to every admission', async () => {
      const event = await occurrence(10, 2000, 1),
        buyer = await actor();
      await inventory.product(
        owner,
        event.id,
        {
          name: 'Admission with optional vouchers',
          priceMinor: 2000,
          taxBps: 1000,
          capacity: 10,
          drinks: 1,
          extraDrinkPriceMinor: 500,
          extraDrinkLimit: 2,
          extraDrinkTaxBps: 2200,
          saleStartsAt: new Date(Date.now() - 3600_000).toISOString(),
          saleEndsAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
          active: true,
          expectedVersion: 1,
        },
        event.productId,
      );
      const input = {
        occurrenceId: event.id,
        email: buyer.email,
        items: [{ productId: event.productId, quantity: 2, extraDrinks: 2 }],
      };
      const held = await orders.hold(buyer.principal, input, randomUUID());
      expect(held.data.totalMinor).toBe(6000);
      const payment = await orders.startPayment(buyer.principal, held.data.id, true);
      await orders.applyPayment(provider.sellerValue.id, provider.succeed(payment.data.paymentIntentId));
      expect(
        (await orders.view(buyer.principal, held.data.id)).data.tickets.map((t) => t.drinksTotal),
      ).toEqual([3, 3]);
      await expect(
        orders.hold(
          buyer.principal,
          { ...input, items: [{ productId: event.productId, quantity: 1, extraDrinks: 3 }] },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ADD_ON' });
    });
    it('exports private commerce data, produces scoped receipts/statements and retains financial deletion obligations', async () => {
      const result = await purchase();
      const privacy = app.get(PrivacyService);
      const request = await privacy.request(result.buyer.principal, { kind: 'export' });
      await db.transaction((tx) => privacy.handler(tx, { requestId: request.data.id }, randomUUID()));
      expect((await privacy.export(result.buyer.principal, request.data.id)).data).toMatchObject({
        bookings: [{ id: result.held.data.id }],
      });
      const billing = app.get(BillingService);
      expect(await billing.receipt(result.buyer.principal, result.held.data.id)).toContain('Booking receipt');
      await expect(billing.receipt((await actor()).principal, result.held.data.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(
        await billing.statement(owner, org, {
          from: new Date(Date.now() - 3600_000).toISOString(),
          to: new Date(Date.now() + 3600_000).toISOString(),
        }),
      ).toContain(result.held.data.id);
      await billing.resend(owner, result.held.data.id, 'Customer requested another confirmation email');
      await expect(
        billing.resend(owner, result.held.data.id, 'Customer requested another confirmation email'),
      ).rejects.toMatchObject({ code: 'RESEND_LIMIT' });
      const deletion = await privacy.request(result.buyer.principal, {
        kind: 'delete',
        confirmConsequences: true,
      });
      await db.transaction((tx) => privacy.handler(tx, { requestId: deletion.data.id }, randomUUID()));
      await privacy.erase(deletion.data.id);
      expect((await privacy.status(result.buyer.principal, deletion.data.id)).data.status).toBe('completed');
      expect(
        (await db.query('SELECT status,total_minor FROM orders WHERE id=$1', [result.held.data.id])).rows[0],
      ).toMatchObject({ status: 'paid' });
    });
  },
);
