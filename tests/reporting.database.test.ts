import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { commerceFixture } from './commerce-fixture';
import { ReportingService } from '../apps/api/src/reporting/reporting.service';
import { InventoryService } from '../apps/api/src/commerce/inventory.service';
import { OrdersService } from '../apps/api/src/commerce/orders.service';
import { RefundsService } from '../apps/api/src/commerce/refunds.service';
import { AdmissionsService } from '../apps/api/src/commerce/admissions.service';
import { SellersService } from '../apps/api/src/commerce/sellers.service';
import { activateTestMarket } from './market-fixture';
import { reportSchema } from '@clubby/contracts';
import { GroupsService } from '../apps/api/src/groups/groups.service';
import { IdentityService } from '../apps/api/src/identity/identity.service';
describe.skipIf(!process.env.TEST_DATABASE_URL)('authoritative scoped reporting', () => {
  let f: Awaited<ReturnType<typeof commerceFixture>>, reports: ReportingService;
  beforeAll(async () => {
    f = await commerceFixture();
    reports = f.app.get(ReportingService);
  });
  afterAll(async () => {
    if (f) await f.close();
  });
  const window = () => ({
    from: new Date(Date.now() - 86400_000).toISOString(),
    to: new Date(Date.now() + 3 * 86400_000).toISOString(),
    timezone: 'Europe/Rome',
  });
  async function booking(buyer?: Awaited<ReturnType<typeof f.actor>>, currency = 'EUR', pay = true) {
    buyer ??= await f.actor();
    const offer = await f.offer();
    if (currency === 'GBP') {
      await f.db.query(
        "INSERT INTO destinations(id,name,country_code,timezone,currency,published) VALUES('london','London','GB','Europe/London','GBP',true) ON CONFLICT DO NOTHING",
      );
      await f.db.query(
        "INSERT INTO venues(id,destination_id,name,status,organization_id,commercial_mode) VALUES('london-venue','london','London venue','published',$1,'native') ON CONFLICT DO NOTHING",
        [f.org],
      );
      await f.db.query(
        "UPDATE events SET venue_id='london-venue' WHERE id=(SELECT event_id FROM occurrences WHERE id=$1)",
        [offer.occurrenceId],
      );
      await f.db.query("UPDATE occurrences SET currency='GBP',timezone='Europe/London' WHERE id=$1", [
        offer.occurrenceId,
      ]);
      await activateTestMarket(f.db, f.admin.principal, f.app.get(SellersService), 'london');
    }
    const product = await f.app.get(InventoryService).product(f.owner.principal, offer.occurrenceId, {
      name: 'Report fixture ticket',
      priceMinor: 1000,
      taxBps: 0,
      capacity: 20,
      drinks: 1,
      saleStartsAt: new Date(Date.now() - 60_000).toISOString(),
      saleEndsAt: offer.ends.toISOString(),
      active: true,
    });
    const orders = f.app.get(OrdersService),
      held = await orders.hold(
        buyer.principal,
        {
          occurrenceId: offer.occurrenceId,
          email: buyer.email,
          items: [{ productId: product.data.id, quantity: 2 }],
        },
        randomUUID(),
      );
    if (pay) {
      const payment = await orders.startPayment(buyer.principal, held.data.id, true);
      await orders.applyPayment(f.provider.sellerValue.id, f.provider.succeed(payment.data.paymentIntentId));
    }
    return { buyer, offer, order: (await orders.view(buyer.principal, held.data.id)).data };
  }
  it('matches partial refunds to ledger figures, reports real admissions and counts repeat checkout buyers', async () => {
    const first = await booking();
    await booking(first.buyer);
    await booking(undefined, 'EUR', false);
    const refunds = f.app.get(RefundsService),
      refund = await refunds.request(
        first.buyer.principal,
        first.order.id,
        { ticketIds: [first.order.tickets[0]!.id], reason: 'Reporting fixture partial refund' },
        randomUUID(),
      );
    await refunds.process(refund.data.id);
    await f.app
      .get(AdmissionsService)
      .manual(
        f.owner.principal,
        { ticketId: first.order.tickets[1]!.id, reason: 'Verified reporting fixture admission' },
        randomUUID(),
      );
    const result = (await reports.report(f.owner.principal, f.org, window())).data;
    expect(reportSchema.safeParse(result).success).toBe(true);
    expect(result.financial).toHaveLength(1);
    expect(result.financial[0]).toMatchObject({
      currency: 'EUR',
      grossMinor: '4000',
      refundMinor: '1000',
      commissionMinor: '375',
      netOnlineMinor: '3000',
      sellerNetBeforeProviderFeesMinor: '2625',
    });
    expect(result.cohort[0]).toMatchObject({
      checkoutsStarted: '3',
      checkoutsPaid: '2',
      buyers: '1',
      repeatBuyers: '1',
    });
    expect(result.admissions.admissions).toBe('1');
    expect(result.reconciliation[0]).toMatchObject({
      captureDifferenceMinor: '0',
      refundDifferenceMinor: '0',
    });
    expect(result.events.find((e) => e.id === first.offer.occurrenceId)).toMatchObject({
      activeAdmissions: '1',
      admitted: '1',
      capacity: 100,
    });
    expect(JSON.stringify(result)).not.toContain(first.buyer.email);
    expect(JSON.stringify(result)).not.toContain('credential');
  });
  it('keeps currencies separate, filters events and uses the requested reporting timezone', async () => {
    const gbp = await booking(undefined, 'GBP'),
      filters = { ...window(), timezone: 'Pacific/Kiritimati' };
    const result = (await reports.report(f.owner.principal, f.org, filters)).data;
    expect(new Set(result.financial.map((r) => r.currency))).toEqual(new Set(['EUR', 'GBP']));
    const day = new Intl.DateTimeFormat('sv-SE', {
      timeZone: filters.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    expect(result.financial.every((r) => r.day === day)).toBe(true);
    const event = (
      await reports.report(f.owner.principal, f.org, { ...filters, occurrenceId: gbp.offer.occurrenceId })
    ).data;
    expect(event.financial).toHaveLength(1);
    expect(event.financial[0]!.grossMinor).toBe('2000');
    expect(event.provider).toBeNull();
    expect(event.events).toHaveLength(1);
    await expect(
      reports.report(f.owner.principal, f.org, { ...filters, timezone: 'Not/A-Timezone' }),
    ).rejects.toThrow();
    await expect(
      reports.report(f.owner.principal, f.org, { ...filters, from: filters.to }),
    ).rejects.toMatchObject({ code: 'INVALID_INTERVAL' });
  });
  it('enforces venue and platform finance access on reads and HTTP exports', async () => {
    const finance = await f.actor(),
      outsider = await f.actor();
    await f.db.query(
      "INSERT INTO memberships(id,organization_id,user_id,role,venue_ids) VALUES($1,$2,$3,'finance',ARRAY['group-venue'])",
      [randomUUID(), f.org, finance.principal.userId],
    );
    const report = (await reports.report(finance.principal, f.org, window())).data;
    expect(report.financial.every((r) => r.currency === 'EUR')).toBe(true);
    expect(report.provider).toBeNull();
    await expect(
      reports.report(finance.principal, f.org, { ...window(), venueId: 'london-venue' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reports.report(outsider.principal, f.org, window())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await f.db.query("INSERT INTO platform_grants(user_id,role) VALUES($1,'support')", [
      outsider.principal.userId,
    ]);
    await expect(reports.report(outsider.principal, null, window())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const platform = (await reports.report(f.admin.principal, null, window())).data;
    expect(platform.financial).toHaveLength(2);
    const response = await f.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/v1/organizations/${f.org}/report-exports`,
        headers: { authorization: `Bearer ${outsider.credentials.token}`, 'idempotency-key': randomUUID() },
        payload: window(),
      });
    expect(response.statusCode).toBe(403);
  });
  it('generates one immutable export snapshot and prevents disclosure after scope narrowing or expiration', async () => {
    const finance = await f.actor();
    await f.db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'finance')", [
      randomUUID(),
      f.org,
      finance.principal.userId,
    ]);
    const filters = window(),
      key = randomUUID(),
      requested = await reports.requestExport(finance.principal, f.org, filters, key);
    expect(await reports.requestExport(finance.principal, f.org, filters, key)).toEqual(requested);
    await reports.generate(requested.data.id);
    const first = await reports.export(finance.principal, requested.data.id);
    await booking();
    await reports.generate(requested.data.id);
    expect((await reports.export(finance.principal, requested.data.id)).data.report).toEqual(
      first.data.report,
    );
    const csv = await reports.csv(finance.principal, requested.data.id);
    expect(csv).toContain('captureDifferenceMinor');
    expect(csv).not.toContain('@example.test');
    const document = await f.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        url: `/v1/report-exports/${requested.data.id}/document`,
        headers: { authorization: `Bearer ${finance.credentials.token}` },
      });
    expect(document.statusCode).toBe(200);
    expect(document.json().data.contents).toBe(csv);
    await expect(reports.export(f.owner.principal, requested.data.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const pending = await reports.requestExport(finance.principal, f.org, filters, randomUUID());
    await f.db.query("UPDATE memberships SET venue_ids=ARRAY['group-venue'] WHERE user_id=$1", [
      finance.principal.userId,
    ]);
    await expect(reports.export(finance.principal, requested.data.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await reports.generate(pending.data.id);
    expect(
      (await f.db.query('SELECT status FROM report_exports WHERE id=$1', [pending.data.id])).rows[0]!.status,
    ).toBe('denied');
    await f.db.query('UPDATE report_exports SET expires_at=now() WHERE id=$1', [requested.data.id]);
    await reports.maintenance();
    expect(
      (
        await f.db.query('SELECT result_encrypted,status FROM report_exports WHERE id=$1', [
          requested.data.id,
        ])
      ).rows[0],
    ).toMatchObject({ status: 'expired', result_encrypted: null });
  });
  it('reports provider activity independently and exposes reconciliation review freshness', async () => {
    const account = f.provider.sellerValue.id;
    await f.db.query(
      "INSERT INTO provider_balance_transactions(account_id,provider_id,currency,amount_minor,fee_minor,net_minor,kind,created_at,available_at) VALUES($1,'txn_report','GBP',2000,75,1925,'payment',now(),now())",
      [account],
    );
    await f.db.query(
      "INSERT INTO reconciliation_runs(id,account_id,status,created_at,completed_at) VALUES($1,$2,'matched',now()-interval '1 hour',now()-interval '1 hour'),($3,$2,'review',now(),now())",
      [randomUUID(), account, randomUUID()],
    );
    const result = (await reports.report(f.owner.principal, f.org, window())).data;
    expect(result.provider!.activity).toEqual([
      { currency: 'GBP', amountMinor: '2000', feeMinor: '75', netMinor: '1925' },
    ]);
    expect(result.provider!.freshness[0]).toMatchObject({ latestStatus: 'review' });
    expect(result.provider!.freshness[0]!.lastMatchedAt).not.toBeNull();
    expect(
      result.reconciliation.every((r) => r.captureDifferenceMinor === '0' && r.refundDifferenceMinor === '0'),
    ).toBe(true);
  });
  it('returns identical scoped figures to authenticated browser and native clients', async () => {
    const web = await f.db.transaction((tx) =>
      f.app.get(IdentityService).issue(tx, f.owner.principal.userId, 'web'),
    );
    const query = new URLSearchParams(window()),
      http = f.app.getHttpAdapter().getInstance();
    const ios = await http.inject({
      url: `/v1/organizations/${f.org}/reports?${query}`,
      headers: { authorization: `Bearer ${f.owner.credentials.token}` },
    });
    const browser = await http.inject({
      url: `/v1/organizations/${f.org}/reports?${query}`,
      headers: { cookie: `clubby_session=${web.token}` },
    });
    expect(ios.statusCode).toBe(200);
    expect(browser.statusCode).toBe(200);
    const a = reportSchema.parse(ios.json().data),
      b = reportSchema.parse(browser.json().data);
    expect(a.financial).toEqual(b.financial);
    expect(a.cohort).toEqual(b.cohort);
    expect(a.events).toEqual(b.events);
    expect(a.reconciliation).toEqual(b.reconciliation);
  });
  it('counts contributor money once and preserves immutable report contracts through real group funding', async () => {
    const owner = await f.actor(),
      member = await f.actor(),
      offer = await f.offer(),
      groups = f.app.get(GroupsService),
      orders = f.app.get(OrdersService);
    const group = await groups.create(
      owner.principal,
      {
        name: 'Reporting group fixture',
        offerId: offer.offerId,
        expectedVersion: 1,
        guests: 4,
        paymentMode: 'deposit',
        deadline: new Date(Date.now() + 600_000).toISOString(),
        acceptTerms: true,
        acceptBalanceResponsibility: true,
      },
      randomUUID(),
    );
    const invite = await groups.invite(owner.principal, group.data.id, { email: member.email });
    await groups.accept(member.principal, invite.data.token);
    for (const person of [owner, member]) {
      const contribution = await groups.contribute(
        person.principal,
        group.data.id,
        { amountMinor: 1500, acceptTerms: true },
        randomUUID(),
      );
      const payment = await orders.startPayment(person.principal, contribution.data.orderId, true);
      await orders.applyPayment(f.provider.sellerValue.id, f.provider.succeed(payment.data.paymentIntentId));
    }
    await groups.reconcile(group.data.id);
    const report = (
      await reports.report(f.owner.principal, f.org, { ...window(), occurrenceId: offer.occurrenceId })
    ).data;
    expect(report.financial[0]).toMatchObject({
      grossMinor: '3000',
      commissionMinor: '1250',
      receivableMovementMinor: '7000',
    });
    expect(report.cohort[0]).toMatchObject({ checkoutsStarted: '2', checkoutsPaid: '2', buyers: '2' });
    expect(report.events[0]).toMatchObject({ activeAdmissions: '4', confirmedTables: '1' });
    expect(report.reconciliation[0]).toMatchObject({
      captureDifferenceMinor: '0',
      refundDifferenceMinor: '0',
      currentTableReceivableMinor: '7000',
    });
    const key = randomUUID(),
      requested = await reports.requestExport(f.owner.principal, f.org, window(), key);
    await f.db.query(
      "UPDATE outbox_jobs SET status='dead',error_code='TEST_FAILURE' WHERE topic='report.generate' AND dedupe_key=$1",
      [requested.data.id],
    );
    expect((await reports.export(f.owner.principal, requested.data.id)).data).toMatchObject({
      status: 'failed',
      errorCode: 'EXPORT_FAILED',
    });
  });
});
