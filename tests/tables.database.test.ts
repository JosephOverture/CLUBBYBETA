import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { isolatedDatabase } from './database-helper';
import { PaymentProviderDouble } from './payment-provider-double';
import { Database } from '../apps/api/src/platform/database';
import { migrate } from '../apps/api/src/platform/migrations';
import { createApplication } from '../apps/api/src/bootstrap';
import { IdentityService, type Principal } from '../apps/api/src/identity/identity.service';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
import { SellersService } from '../apps/api/src/commerce/sellers.service';
import { OrdersService } from '../apps/api/src/commerce/orders.service';
import { RefundsService } from '../apps/api/src/commerce/refunds.service';
import { AdmissionsService } from '../apps/api/src/commerce/admissions.service';
import { InventoryService } from '../apps/api/src/commerce/inventory.service';
import { TablesService } from '../apps/api/src/tables/tables.service';
import { EventsService } from '../apps/api/src/events/events.service';
import { PaymentsService } from '../apps/api/src/commerce/payments.service';
import { activateTestMarket } from './market-fixture';

function localDate(date: Date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${values.timeZoneName!.replace('GMT', '') || '+00:00'}`;
}
describe.skipIf(!process.env.TEST_DATABASE_URL)('exclusive table reservations and deposit accounting', () => {
  let db: Database,
    dispose: () => Promise<void>,
    app: NestFastifyApplication,
    owner: Principal,
    org: string,
    tables: TablesService,
    orders: OrdersService,
    refunds: RefundsService,
    admissions: AdmissionsService,
    inventory: InventoryService,
    layoutId: string,
    physicalId: string,
    secondId: string;
  const provider = new PaymentProviderDouble();
  async function actor() {
    const id = randomUUID(),
      email = `${id}@example.test`;
    await db.query("INSERT INTO users(id,email,email_verified_at,kind) VALUES($1,$2,now(),'registered')", [
      id,
      email,
    ]);
    const identity = app.get(IdentityService);
    const credentials = await db.transaction((tx) => identity.issue(tx, id, 'ios'));
    return {
      principal: await identity.authenticate({
        method: 'GET',
        headers: { authorization: `Bearer ${credentials.token}` },
        cookies: {},
      } as FastifyRequest),
      email,
    };
  }
  const table = (label: string, x: number) => ({
    label,
    zoneId: 'main',
    seats: 16,
    x,
    y: 0.5,
    width: 0.15,
    height: 0.15,
    rotation: 0,
    shape: 'circle' as const,
  });
  async function event(capacity = 100) {
    const id = randomUUID(),
      eventId = randomUUID(),
      starts = new Date(Math.floor((Date.now() + 10 * 60_000) / 1000) * 1000),
      ends = new Date(starts.getTime() + 4 * 3600_000);
    await db.query(
      "INSERT INTO events(id,venue_id,organization_id,title,status) VALUES($1,'table-club',$2,'Table fixture','published')",
      [eventId, org],
    );
    await db.query(
      "INSERT INTO occurrences(id,event_id,starts_at,ends_at,timezone,currency,capacity,status) VALUES($1,$2,$3,$4,'Europe/Rome','EUR',$5,'published')",
      [id, eventId, starts, ends, capacity],
    );
    await tables.pin(owner, id, {
      layoutId,
      expectedVersion: 0,
      reason: 'Reviewed floor plan for this occurrence',
    });
    return { id, eventId, starts, ends };
  }
  async function offer(
    occurrence: Awaited<ReturnType<typeof event>>,
    tableId = physicalId,
    offsetHours = 0,
    deposit = 3000,
  ) {
    return tables.offer(owner, occurrence.id, {
      tableId,
      slotStartsAt: localDate(new Date(occurrence.starts.getTime() + offsetHours * 3600_000)),
      slotEndsAt: localDate(new Date(occurrence.starts.getTime() + (offsetHours + 2) * 3600_000)),
      minGuests: 1,
      maxGuests: 16,
      fullPriceMinor: 10000,
      depositMinor: deposit,
      taxBps: 2200,
      drinksPerGuest: 1,
      inclusions: 'A table and the included venue package',
      minimumSpendMinor: 10000,
      terms: 'Refund the whole table before the published cutoff. Paid no-shows are retained.',
      noShowAfterMinutes: 5,
      noShowPolicy: 'retain-paid',
      active: true,
    });
  }
  async function reserve(full = false, guests = 4, tableId = physicalId) {
    const buyer = await actor(),
      e = await event(),
      o = await offer(e, tableId);
    const held = await tables.hold(
      buyer.principal,
      {
        offerId: o.data.id,
        expectedVersion: 1,
        guests,
        paymentMode: full ? 'full' : 'deposit',
        email: buyer.email,
      },
      randomUUID(),
    );
    return { buyer, event: e, offer: o, held };
  }
  async function paid(full = false, guests = 4, tableId = physicalId) {
    const result = await reserve(full, guests, tableId);
    const session = await orders.startPayment(result.buyer.principal, result.held.data.order.id, true);
    await orders.applyPayment(provider.sellerValue.id, provider.succeed(session.data.paymentIntentId));
    return result;
  }
  beforeAll(async () => {
    ({ db, dispose } = await isolatedDatabase({
      APP_ENCRYPTION_KEY: 'e1'.repeat(32),
      EMAIL_MODE: 'file',
      STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_fixture',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture',
      STRIPE_WEBHOOK_SECRETS: 'whsec_tablefixture',
      STRIPE_ONBOARDING_ORIGIN: 'http://localhost:8081',
    }));
    await migrate(db, resolve('database/migrations'));
    app = await createApplication(db.config, db, { paymentProvider: provider });
    tables = app.get(TablesService);
    orders = app.get(OrdersService);
    refunds = app.get(RefundsService);
    admissions = app.get(AdmissionsService);
    inventory = app.get(InventoryService);
    ({ principal: owner } = await actor());
    const admin = (await actor()).principal;
    await db.query("INSERT INTO platform_grants(user_id,role) VALUES($1,'admin')", [admin.userId]);
    const organizations = app.get(OrganizationsService);
    org = (
      await organizations.apply(owner, {
        name: 'Table venue',
        legalName: 'Table seller company',
        countryCode: 'IT',
      })
    ).data.id;
    await organizations.review(admin, org, {
      status: 'approved',
      expectedVersion: 1,
      reason: 'Test venue organization approved',
    });
    await db.query(
      "INSERT INTO destinations(id,name,country_code,timezone,currency,published,native_sales_enabled) VALUES('milan','Milan','IT','Europe/Rome','EUR',true,true)",
    );
    await db.query(
      "INSERT INTO venues(id,destination_id,name,status,organization_id,commercial_mode) VALUES('table-club','milan','Table Club','published',$1,'native')",
      [org],
    );
    await db.query('UPDATE public_settings SET new_sales_paused=false');
    const sellers = app.get(SellersService);
    const policy = await sellers.policy(admin, org, {
      commissionBps: 1250,
      refundCutoffHours: 0,
      refundCommission: true,
      terms: 'Development test commercial terms with full package commission collected in the deposit.',
      taxRegistration: 'IT-FIXTURE',
      processingFeeBearer: 'seller',
      payoutModel: 'stripe-managed',
      reason: 'Table commerce test policy',
    });
    await sellers.accept(owner, org, policy.data.id);
    await sellers.onboard(owner, org);
    await activateTestMarket(db, admin, sellers);
    const layout = await tables.layout(owner, 'table-club', {
      name: 'Main floor',
      zones: [{ id: 'main', label: 'Main room' }],
      tables: [table('A', 0.25), table('B', 0.75)],
      expectedVersion: 0,
      reason: 'Real test floor layout',
    });
    layoutId = layout.data.id;
    physicalId = layout.data.content.tables[0]!.id;
    secondId = layout.data.content.tables[1]!.id;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
    else if (db) await db.onApplicationShutdown();
    if (dispose) await dispose();
  });
  // Each test explicitly releases its physical allocation so the next independent occurrence may reuse the table.
  async function clearAllocations() {
    await db.query("UPDATE table_allocations SET status='released'");
  }
  it('sells one overlapping physical slot across concurrent clients and leaves a later slot bookable', async () => {
    await clearAllocations();
    const e = await event(),
      first = await offer(e),
      later = await offer(e, physicalId, 2);
    const buyers = await Promise.all(Array.from({ length: 8 }, () => actor()));
    const results = await Promise.allSettled(
      buyers.map((b) =>
        tables.hold(
          b.principal,
          { offerId: first.data.id, expectedVersion: 1, guests: 4, paymentMode: 'deposit', email: b.email },
          randomUUID(),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => (r as PromiseRejectedResult).reason.code === 'TABLE_UNAVAILABLE'),
    ).toBe(true);
    const b = await actor();
    await tables.hold(
      b.principal,
      { offerId: later.data.id, expectedVersion: 1, guests: 4, paymentMode: 'full', email: b.email },
      randomUUID(),
    );
    expect((await tables.availability(e.id)).data.offers.every((o) => !o.available)).toBe(true);
  });
  it('enforces physical overlap in PostgreSQL even outside the application command', async () => {
    await clearAllocations();
    const a = await reserve(false, 4),
      b = await reserve(false, 4, secondId);
    await expect(
      db.query('UPDATE table_allocations SET table_id=$1 WHERE reservation_id=$2', [
        physicalId,
        b.held.data.reservationId,
      ]),
    ).rejects.toMatchObject({ code: '23P01' });
    expect((await tables.view(a.buyer.principal, a.held.data.reservationId)).data.status).toBe('held');
  });
  it('prevents bypassing exclusive holds through a guessed table product ID', async () => {
    await clearAllocations();
    const e = await event(),
      o = await offer(e),
      buyer = await actor();
    expect((await inventory.offers(e.id)).data).toHaveLength(0);
    await expect(
      orders.hold(
        buyer.principal,
        { occurrenceId: e.id, items: [{ productId: o.data.productId, quantity: 1 }], email: buyer.email },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PRODUCT' });
  });
  it('counts every table guest against shared occurrence admission capacity', async () => {
    await clearAllocations();
    const e = await event(10),
      o = await offer(e),
      buyer = await actor();
    await tables.hold(
      buyer.principal,
      { offerId: o.data.id, expectedVersion: 1, guests: 8, paymentMode: 'deposit', email: buyer.email },
      randomUUID(),
    );
    const product = await inventory.product(owner, e.id, {
      name: 'General admission',
      priceMinor: 1000,
      taxBps: 2200,
      capacity: 10,
      drinks: 0,
      saleStartsAt: new Date(Date.now() - 1000).toISOString(),
      saleEndsAt: e.ends.toISOString(),
      active: true,
    });
    const other = await actor();
    await expect(
      orders.hold(
        other.principal,
        { occurrenceId: e.id, items: [{ productId: product.data!.id, quantity: 3 }], email: other.email },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'SOLD_OUT' });
  });
  it('issues one credential per table guest and requires the remaining balance before entry', async () => {
    await clearAllocations();
    const result = await paid();
    expect(result.held.data.order.totalMinor).toBe(3000);
    expect(result.held.data.order.commissionMinor).toBe(1250);
    const view = await orders.view(result.buyer.principal, result.held.data.order.id);
    expect(view.data.tickets).toHaveLength(4);
    const ticket = await admissions.ticket(result.buyer.principal, view.data.tickets[0]!.id);
    const scan = { occurrenceId: result.event.id, credential: ticket.data.credential, kind: 'admission' };
    expect((await admissions.scan(owner, scan, randomUUID())).data.outcome).toBe('balance-due');
    await expect(
      admissions.manual(
        owner,
        { ticketId: ticket.data.id, reason: 'Manager cannot bypass the unpaid balance' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'TABLE_BALANCE_DUE' });
    await tables.collect(
      owner,
      result.held.data.reservationId,
      {
        amountMinor: 7000,
        method: 'cash',
        reference: randomUUID(),
        reason: 'Received the remaining package balance',
      },
      randomUUID(),
    );
    expect((await admissions.scan(owner, scan, randomUUID())).data.outcome).toBe('accepted');
  });
  it('serializes balance collection, rejects overpayment and posts reversible audited corrections', async () => {
    await clearAllocations();
    const result = await paid(),
      input = {
        amountMinor: 7000,
        method: 'external-card',
        reference: randomUUID(),
        reason: 'Approved external terminal receipt',
      };
    const key = randomUUID();
    const responses = await Promise.all([
      tables.collect(owner, result.held.data.reservationId, input, key),
      tables.collect(owner, result.held.data.reservationId, input, key),
    ]);
    expect(responses[0]).toEqual(responses[1]);
    await expect(
      tables.collect(
        owner,
        result.held.data.reservationId,
        { ...input, reference: randomUUID() },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'BALANCE_EXCEEDED' });
    await tables.reverseCollection(
      owner,
      responses[0].data.id,
      { reference: randomUUID(), reason: 'Terminal receipt was voided by the manager' },
      randomUUID(),
    );
    expect(
      (await tables.view(result.buyer.principal, result.held.data.reservationId)).data.balanceDueMinor,
    ).toBe(7000);
    expect(
      (
        await db.query(
          'SELECT journal_id FROM ledger_postings GROUP BY journal_id HAVING sum(amount_minor)<>0',
        )
      ).rowCount,
    ).toBe(0);
  });
  it('refunds the complete party and separately tracks money already collected at the door', async () => {
    await clearAllocations();
    const result = await paid();
    const tickets = (await orders.view(result.buyer.principal, result.held.data.order.id)).data.tickets;
    await expect(
      refunds.request(
        result.buyer.principal,
        result.held.data.order.id,
        { ticketIds: [tickets[0]!.id], reason: 'Attempted partial table party refund' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'TABLE_REFUND_REQUIRED' });
    const collected = await tables.collect(
      owner,
      result.held.data.reservationId,
      {
        amountMinor: 1000,
        method: 'cash',
        reference: randomUUID(),
        reason: 'Partial door balance received before cancellation',
      },
      randomUUID(),
    );
    const refund = await refunds.request(
      result.buyer.principal,
      result.held.data.order.id,
      { ticketIds: tickets.map((t) => t.id), reason: 'Customer cancelled the entire unused table' },
      randomUUID(),
    );
    await refunds.process(refund.data.id);
    expect((await tables.view(result.buyer.principal, result.held.data.reservationId)).data.status).toBe(
      'refund-review',
    );
    await tables.reverseCollection(
      owner,
      collected.data.id,
      { reference: randomUUID(), reason: 'Cash returned to the customer after cancellation' },
      randomUUID(),
    );
    expect((await tables.view(result.buyer.principal, result.held.data.reservationId)).data.status).toBe(
      'cancelled',
    );
  });
  it('retains the purchased layout snapshot when a later layout revision is saved', async () => {
    await clearAllocations();
    const result = await reserve();
    const previous = (await tables.view(result.buyer.principal, result.held.data.reservationId)).data.snapshot
      .table.x;
    const latest = (await tables.layouts(owner, 'table-club')).data[0]!;
    await tables.layout(owner, 'table-club', {
      name: 'Rearranged future floor',
      zones: [{ id: 'main', label: 'Main room' }],
      tables: [
        { ...table('A', 0.35), id: physicalId },
        { ...table('B', 0.75), id: secondId },
      ],
      expectedVersion: latest.version,
      reason: 'Future floor plan revision',
    });
    expect(
      (await tables.view(result.buyer.principal, result.held.data.reservationId)).data.snapshot.table.x,
    ).toBe(previous);
    await expect(
      tables.pin(owner, result.event.id, {
        layoutId: (await tables.layouts(owner, 'table-club')).data[0]!.id,
        expectedVersion: 1,
        reason: 'Try to change an already offered floor plan',
      }),
    ).rejects.toMatchObject({ code: 'LAYOUT_COMMITTED' });
  });
  it('releases unpaid table holds only after the shared payment cancellation workflow', async () => {
    await clearAllocations();
    const result = await reserve();
    await orders.cancel(result.buyer.principal, result.held.data.order.id);
    await orders.expire(result.held.data.order.id);
    expect((await tables.view(result.buyer.principal, result.held.data.reservationId)).data.status).toBe(
      'cancelled',
    );
    expect((await tables.availability(result.event.id)).data.offers[0]!.available).toBe(true);
  });
  it('requires a sufficient deposit for full-package commission and enforces retained-paid no-show terms', async () => {
    await clearAllocations();
    const e = await event(),
      o = await offer(e, physicalId, 0, 100),
      buyer = await actor();
    await expect(
      tables.hold(
        buyer.principal,
        { offerId: o.data.id, expectedVersion: 1, guests: 4, paymentMode: 'deposit', email: buyer.email },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'DEPOSIT_TOO_SMALL' });
    const result = await paid();
    await expect(
      tables.noShow(owner, result.held.data.reservationId, 'Guest did not arrive at the reserved table'),
    ).rejects.toMatchObject({ code: 'NO_SHOW_UNAVAILABLE' });
    const mocked = vi.spyOn(Date, 'now').mockReturnValue(result.event.starts.getTime() + 6 * 60_000);
    try {
      expect(
        (
          await tables.noShow(
            owner,
            result.held.data.reservationId,
            'Guest did not arrive after the agreed grace period',
          )
        ).data.retainedMinor,
      ).toBe(3000);
    } finally {
      mocked.mockRestore();
    }
    expect(
      (await orders.view(result.buyer.principal, result.held.data.order.id)).data.tickets.every(
        (t) => t.status === 'void',
      ),
    ).toBe(true);
  });
  it('keeps reservation data private and requires venue authorization for balance collection', async () => {
    await clearAllocations();
    const result = await paid(),
      outsider = (await actor()).principal;
    await expect(tables.view(outsider, result.held.data.reservationId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(tables.view(outsider, result.held.data.reservationId, true)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      tables.collect(
        outsider,
        result.held.data.reservationId,
        {
          amountMinor: 100,
          method: 'cash',
          reference: randomUUID(),
          reason: 'Attempt to collect another venue balance',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      db.query('UPDATE table_reservations SET full_price_minor=1 WHERE id=$1', [
        result.held.data.reservationId,
      ]),
    ).rejects.toThrow('immutable');
    await expect(
      db.query('UPDATE table_offers SET full_price_minor=2 WHERE id=$1', [result.offer.data.id]),
    ).rejects.toThrow('immutable');
  });
  it('prevents using one terminal receipt for two separate reservations', async () => {
    await clearAllocations();
    const a = await paid(),
      b = await paid(false, 4, secondId),
      input = {
        amountMinor: 1000,
        method: 'external-card',
        reference: randomUUID(),
        reason: 'External terminal transaction received',
      };
    await tables.collect(owner, a.held.data.reservationId, input, randomUUID());
    await expect(tables.collect(owner, b.held.data.reservationId, input, randomUUID())).rejects.toMatchObject(
      { code: 'RECEIPT_ALREADY_RECORDED' },
    );
  });
  it('allows a versioned offer withdrawal without mutating a held purchase', async () => {
    await clearAllocations();
    const result = await reserve();
    await tables.offerStatus(owner, result.offer.data.id, {
      active: false,
      expectedVersion: 1,
      reason: 'Withdraw this table package from future sales',
    });
    expect((await tables.availability(result.event.id)).data.offers).toHaveLength(0);
    await expect(
      tables.offerStatus(owner, result.offer.data.id, {
        active: true,
        expectedVersion: 1,
        reason: 'Reopen a stale table offer version',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const session = await orders.startPayment(result.buyer.principal, result.held.data.order.id, true);
    await orders.applyPayment(provider.sellerValue.id, provider.succeed(session.data.paymentIntentId));
    expect((await tables.view(result.buyer.principal, result.held.data.reservationId)).data.status).toBe(
      'confirmed',
    );
  });
  it('cancels physical appointments and compensates payments when their event moves', async () => {
    await clearAllocations();
    const result = await paid();
    await app.get(EventsService).changeOccurrence(owner, result.event.id, {
      action: 'reschedule',
      expectedVersion: 1,
      startsAt: localDate(new Date(result.event.starts.getTime() + 86400_000)),
      endsAt: localDate(new Date(result.event.ends.getTime() + 86400_000)),
      reason: 'Venue moved the complete event to tomorrow',
    });
    expect(
      (await orders.view(result.buyer.principal, result.held.data.order.id)).data.table!.snapshot
        .slotStartsAt,
    ).toBe(result.event.starts.toISOString());
    const ticket = (await orders.view(result.buyer.principal, result.held.data.order.id)).data.tickets[0]!;
    expect((await admissions.ticket(result.buyer.principal, ticket.id)).data.credential).toBeNull();
    const change = (
      await db.query('SELECT id FROM catalogue_changes WHERE aggregate_id=$1', [result.event.id])
    ).rows[0]!;
    await db.transaction((tx) =>
      app.get(PaymentsService).catalogueChanged(tx, { changeId: change.id }, randomUUID()),
    );
    await refunds.compensate(result.held.data.order.id);
    const refund = (await db.query('SELECT id FROM refunds WHERE order_id=$1', [result.held.data.order.id]))
      .rows[0]!;
    await refunds.process(refund.id);
    expect((await tables.view(result.buyer.principal, result.held.data.reservationId)).data.status).toBe(
      'cancelled',
    );
  });
  it('does not recreate waived debt when correcting a door payment after a no-show', async () => {
    await clearAllocations();
    const result = await paid(),
      collection = await tables.collect(
        owner,
        result.held.data.reservationId,
        {
          amountMinor: 1000,
          method: 'cash',
          reference: randomUUID(),
          reason: 'Early partial cash balance received',
        },
        randomUUID(),
      );
    const mocked = vi.spyOn(Date, 'now').mockReturnValue(result.event.starts.getTime() + 6 * 60_000);
    try {
      await tables.noShow(
        owner,
        result.held.data.reservationId,
        'The party never arrived after the grace period',
      );
    } finally {
      mocked.mockRestore();
    }
    await tables.reverseCollection(
      owner,
      collection.data.id,
      { reference: randomUUID(), reason: 'Manager returned the early cash payment' },
      randomUUID(),
    );
    expect(
      (await tables.view(result.buyer.principal, result.held.data.reservationId)).data.balanceDueMinor,
    ).toBe(0);
    expect(
      Number(
        (
          await db.query(
            "SELECT sum(p.amount_minor) AS total FROM ledger_postings p JOIN ledger_journals j ON j.id=p.journal_id WHERE j.order_id=$1 AND p.account='seller-receivable'",
            [result.held.data.order.id],
          )
        ).rows[0]!.total,
      ),
    ).toBe(0);
  });
  it('uses the same exclusion invariant for staff blocks and customer reservations', async () => {
    await clearAllocations();
    const e = await event(),
      o = await offer(e),
      buyer = await actor();
    const block = await tables.block(
      owner,
      physicalId,
      {
        startsAt: localDate(e.starts),
        endsAt: localDate(e.ends),
        reason: 'Table unavailable while equipment is repaired',
      },
      randomUUID(),
    );
    expect((await tables.availability(e.id)).data.offers[0]!.available).toBe(false);
    const request = {
      offerId: o.data.id,
      expectedVersion: 1,
      guests: 4,
      paymentMode: 'full',
      email: buyer.email,
    };
    await expect(tables.hold(buyer.principal, request, randomUUID())).rejects.toMatchObject({
      code: 'TABLE_UNAVAILABLE',
    });
    await tables.releaseBlock(owner, block.data.id, 'Repairs completed and reviewed by the manager');
    await tables.hold(buyer.principal, request, randomUUID());
    await expect(
      tables.block(
        owner,
        physicalId,
        {
          startsAt: localDate(e.starts),
          endsAt: localDate(e.ends),
          reason: 'Attempt to block a customer reservation',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'TABLE_UNAVAILABLE' });
  });
});
