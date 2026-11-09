import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { commerceFixture } from './commerce-fixture';
import { AdministrationService } from '../apps/api/src/administration/administration.service';
import { CatalogueService } from '../apps/api/src/catalogue/catalogue.service';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
import { SellersService } from '../apps/api/src/commerce/sellers.service';
import { OrdersService } from '../apps/api/src/commerce/orders.service';
import { InventoryService } from '../apps/api/src/commerce/inventory.service';
import { AdmissionsService } from '../apps/api/src/commerce/admissions.service';
import { GroupsService } from '../apps/api/src/groups/groups.service';
import { TransfersService } from '../apps/api/src/tickets/transfers.service';
describe.skipIf(!process.env.TEST_DATABASE_URL)('reviewed administration and market boundaries', () => {
  let f: Awaited<ReturnType<typeof commerceFixture>>,
    admin: AdministrationService,
    sellers: SellersService,
    orgs: OrganizationsService;
  beforeAll(async () => {
    f = await commerceFixture();
    admin = f.app.get(AdministrationService);
    sellers = f.app.get(SellersService);
    orgs = f.app.get(OrganizationsService);
  });
  afterAll(async () => {
    if (f) await f.close();
  });
  const reason = 'Reviewed operational change with recorded evidence';
  const checks = {
    catalogueReviewed: true,
    providerSupported: true,
    refundAndTaxTermsReviewed: true,
    payoutsReviewed: true,
    localSupportReady: true,
    privacyReviewed: true,
  };
  async function paid() {
    const buyer = await f.actor(),
      offer = await f.offer(),
      orders = f.app.get(OrdersService);
    const product = await f.app.get(InventoryService).product(f.owner.principal, offer.occurrenceId, {
      name: 'Admin fixture entry',
      priceMinor: 1000,
      taxBps: 0,
      capacity: 10,
      drinks: 0,
      saleStartsAt: new Date(Date.now() - 60_000).toISOString(),
      saleEndsAt: offer.ends.toISOString(),
      active: true,
    });
    const input = {
      occurrenceId: offer.occurrenceId,
      email: buyer.email,
      items: [{ productId: product.data.id, quantity: 1 }],
    };
    const order = await orders.hold(buyer.principal, input, randomUUID());
    const session = await orders.startPayment(buyer.principal, order.data.id, true);
    await orders.applyPayment(f.provider.sellerValue.id, f.provider.succeed(session.data.paymentIntentId));
    const ticket = (await f.db.query('SELECT id FROM tickets WHERE order_id=$1', [order.data.id])).rows[0]!;
    return { buyer, order: order.data, offer, input, ticket };
  }
  it('denies unauthorized customer lookup and protects the last admin while versioning grants', async () => {
    const user = await f.actor();
    await expect(admin.users(user.principal, { query: f.admin.email })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await admin.users(f.admin.principal, { query: user.email })).data[0]!.id).toBe(
      user.principal.userId,
    );
    await expect(
      admin.grant(f.admin.principal, f.admin.principal.userId, {
        role: 'admin',
        active: false,
        expectedVersion: 1,
        reason,
      }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    const granted = await admin.grant(f.admin.principal, user.principal.userId, {
      role: 'support',
      active: true,
      expectedVersion: 0,
      reason,
    });
    expect(granted.data.version).toBe(1);
    const race = await Promise.allSettled([
      admin.grant(f.admin.principal, user.principal.userId, {
        role: 'support',
        active: false,
        expectedVersion: 1,
        reason,
      }),
      admin.grant(f.admin.principal, user.principal.userId, {
        role: 'support',
        active: false,
        expectedVersion: 1,
        reason,
      }),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await orgs.capabilities(user.principal)).data.platform).toEqual([]);
  });
  it('revokes sessions and outstanding invitations on suspension without erasing paid financial history', async () => {
    const b = await paid(),
      receiver = await f.actor(),
      transfer = await f.app
        .get(TransfersService)
        .create(b.buyer.principal, b.ticket.id, { email: receiver.email }, randomUUID());
    await admin.userStatus(f.admin.principal, b.buyer.principal.userId, {
      status: 'suspended',
      expectedVersion: 1,
      reason,
    });
    const denied = await f.app
      .getHttpAdapter()
      .getInstance()
      .inject({ url: '/v1/auth/session', headers: { authorization: `Bearer ${b.buyer.credentials.token}` } });
    expect(denied.statusCode).toBe(401);
    expect(
      (await f.db.query('SELECT status FROM ticket_transfers WHERE id=$1', [transfer.data.id])).rows[0]!
        .status,
    ).toBe('revoked');
    expect((await f.db.query('SELECT status FROM orders WHERE id=$1', [b.order.id])).rows[0]!.status).toBe(
      'paid',
    );
    await expect(
      f.app.get(AdmissionsService).manual(f.owner.principal, { ticketId: b.ticket.id, reason }, randomUUID()),
    ).rejects.toMatchObject({ code: 'TICKET_INACTIVE' });
    await admin.userStatus(f.admin.principal, b.buyer.principal.userId, {
      status: 'active',
      expectedVersion: 2,
      reason,
    });
    const stillRevoked = await f.app
      .getHttpAdapter()
      .getInstance()
      .inject({ url: '/v1/auth/session', headers: { authorization: `Bearer ${b.buyer.credentials.token}` } });
    expect(stillRevoked.statusCode).toBe(401);
  });
  it('requires recent authentication for privileged HTTP changes', async () => {
    const user = await f.actor();
    await f.db.query("INSERT INTO platform_grants(user_id,role) VALUES($1,'admin')", [user.principal.userId]);
    await f.db.query("UPDATE sessions SET created_at=now()-interval '16 minutes' WHERE id=$1", [
      user.principal.sessionId,
    ]);
    const response = await f.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/v1/admin/users/${f.owner.principal.userId}/grants`,
        headers: { authorization: `Bearer ${user.credentials.token}` },
        payload: { role: 'finance', active: true, expectedVersion: 0, reason },
      });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('REAUTHENTICATION_REQUIRED');
    await admin.grant(f.admin.principal, user.principal.userId, {
      role: 'admin',
      active: false,
      expectedVersion: 1,
      reason,
    });
  });
  it('enables another currency only after a complete immutable market review and eligible seller setup', async () => {
    const catalogue = f.app.get(CatalogueService);
    await catalogue.destination(f.admin.principal, {
      id: 'london',
      name: 'London',
      countryCode: 'GB',
      timezone: 'Europe/London',
      currency: 'GBP',
      published: true,
      aliases: [],
      reason,
    });
    await expect(
      sellers.market(f.admin.principal, 'london', { enabled: true, expectedVersion: 1, reason }),
    ).rejects.toMatchObject({ code: 'MARKET_NOT_READY' });
    const input = {
      expectedVersion: 1,
      sellerCountries: ['IT'],
      checks,
      evidence:
        'Isolated London fixture: reviewed currency, provider availability and commercial policy evidence.',
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      reason,
    };
    await expect(
      admin.reviewMarket(f.admin.principal, 'london', {
        ...input,
        checks: { ...checks, providerSupported: false },
      }),
    ).rejects.toThrow();
    const review = await admin.reviewMarket(f.admin.principal, 'london', input);
    await expect(
      sellers.market(f.admin.principal, 'london', { enabled: true, expectedVersion: 2, reason }),
    ).rejects.toMatchObject({ code: 'MARKET_NOT_READY' });
    await f.db.query(
      "INSERT INTO venues(id,destination_id,name,status,organization_id,commercial_mode) VALUES('london-fixture','london','London fixture','published',$1,'native')",
      [f.org],
    );
    expect(
      (await sellers.market(f.admin.principal, 'london', { enabled: true, expectedVersion: 2, reason })).data!
        .native_sales_enabled,
    ).toBe(true);
    await expect(
      f.db.query("UPDATE market_reviews SET evidence='changed' WHERE id=$1", [review.data.reviewId]),
    ).rejects.toThrow('append-only');
    await expect(
      sellers.market(f.admin.principal, 'london', { enabled: false, expectedVersion: 2, reason }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('checks market evidence at checkout even if the stored switch is enabled, while preserving existing bookings', async () => {
    const b = await paid(),
      orders = f.app.get(OrdersService),
      market = (await f.db.query("SELECT market_review_id FROM destinations WHERE id='milan'")).rows[0]!;
    await f.db.query("UPDATE destinations SET market_review_id=NULL WHERE id='milan'");
    try {
      await expect(orders.hold(b.buyer.principal, b.input, randomUUID())).rejects.toMatchObject({
        code: 'SALES_PAUSED',
      });
      expect((await orders.view(b.buyer.principal, b.order.id)).data.id).toBe(b.order.id);
    } finally {
      await f.db.query("UPDATE destinations SET market_review_id=$1 WHERE id='milan'", [
        market.market_review_id,
      ]);
    }
  });
  it('enforces paused feature commands on direct APIs while retaining reads and pending transfer revocation', async () => {
    const b = await paid(),
      recipient = await f.actor(),
      transfers = f.app.get(TransfersService),
      invite = await transfers.create(
        b.buyer.principal,
        b.ticket.id,
        { email: recipient.email },
        randomUUID(),
      ),
      catalogue = f.app.get(CatalogueService);
    const settings = (await f.db.query('SELECT * FROM public_settings')).rows[0]!;
    await expect(
      catalogue.settings(f.admin.principal, {
        banner: '',
        newSalesPaused: false,
        expectedVersion: settings.version,
        features: { ...settings.features, secretKey: 'do-not-accept' },
        reason,
      }),
    ).rejects.toThrow();
    const off = { groupCreation: false, ticketTransfers: false, walletCreation: false, chatMessages: false };
    const changed = await catalogue.settings(f.admin.principal, {
      banner: 'Maintenance',
      newSalesPaused: false,
      expectedVersion: settings.version,
      features: off,
      reason,
    });
    try {
      await expect(
        transfers.create(b.buyer.principal, b.ticket.id, { email: recipient.email }, randomUUID()),
      ).rejects.toMatchObject({ code: 'FEATURE_PAUSED' });
      await transfers.revoke(b.buyer.principal, invite.data.id);
      expect((await transfers.list(b.buyer.principal)).data.some((t) => t.id === b.ticket.id)).toBe(true);
      await expect(
        f.app.get(GroupsService).create(
          b.buyer.principal,
          {
            name: 'Paused group',
            offerId: b.offer.offerId,
            expectedVersion: 1,
            guests: 4,
            paymentMode: 'deposit',
            deadline: new Date(Date.now() + 600_000).toISOString(),
            acceptTerms: true,
            acceptBalanceResponsibility: true,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'FEATURE_PAUSED' });
      const bootstrap = await f.app.getHttpAdapter().getInstance().inject({ url: '/v1/bootstrap' });
      expect(bootstrap.json().settings.features).toEqual(off);
    } finally {
      await catalogue.settings(f.admin.principal, {
        banner: '',
        newSalesPaused: false,
        expectedVersion: changed.data!.version,
        features: settings.features,
        reason,
      });
    }
  });
  it('requires incoming-owner acceptance and current organization/policy evidence before transferring responsibilities', async () => {
    const owner = await f.actor(),
      incoming = await f.actor(),
      outsider = await f.actor();
    const org = await orgs.apply(owner.principal, {
      name: 'Ownership test',
      legalName: 'Ownership fixture legal entity',
      countryCode: 'IT',
    });
    await orgs.review(f.admin.principal, org.data.id, { status: 'approved', expectedVersion: 1, reason });
    const invitation = await admin.prepareOwnerTransfer(f.admin.principal, org.data.id, {
      fromUserId: owner.principal.userId,
      toUserId: incoming.principal.userId,
      expectedVersion: 2,
      reason,
    });
    expect((await admin.ownerInvitations(incoming.principal)).data[0]!.id).toBe(invitation.data.id);
    await expect(
      admin.acceptOwnership(outsider.principal, invitation.data.id, { acceptResponsibilities: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      admin.acceptOwnership(incoming.principal, invitation.data.id, { acceptResponsibilities: false }),
    ).rejects.toThrow();
    await admin.acceptOwnership(incoming.principal, invitation.data.id, { acceptResponsibilities: true });
    await admin.acceptOwnership(incoming.principal, invitation.data.id, { acceptResponsibilities: true });
    await expect(orgs.authorize(owner.principal, org.data.id, 'members.manage')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await orgs.authorize(incoming.principal, org.data.id, 'members.manage');
    expect(
      (await f.db.query('SELECT version FROM organizations WHERE id=$1', [org.data.id])).rows[0]!.version,
    ).toBe(3);
  });
  it('keeps filtered audit pages ordered by numeric IDs and read-only', async () => {
    const resource = randomUUID();
    await f.db.query(
      "INSERT INTO audit_events(actor_id,action,resource_type,resource_id,reason) SELECT $1,'fixture.audit','fixture',$2,'Audit pagination fixture '||n FROM generate_series(1,105) n",
      [f.admin.principal.userId, resource],
    );
    const inject = f.app.getHttpAdapter().getInstance(),
      headers = { authorization: `Bearer ${f.admin.credentials.token}` };
    const first = (await inject.inject({ url: `/v1/admin/audit?resourceId=${resource}`, headers })).json();
    expect(first.data).toHaveLength(100);
    const next = (
      await inject.inject({
        url: `/v1/admin/audit?resourceId=${resource}&before=${first.meta.nextCursor}`,
        headers,
      })
    ).json();
    expect(next.data).toHaveLength(5);
    expect(new Set([...first.data, ...next.data].map((r: any) => r.id)).size).toBe(105);
    await expect(f.db.query('DELETE FROM audit_events WHERE resource_id=$1', [resource])).rejects.toThrow(
      'append-only',
    );
  });
  it('restricts seller review details and allows revocation before ownership acceptance', async () => {
    const incoming = await f.actor(),
      owner = await f.actor();
    const org = await orgs.apply(owner.principal, {
      name: 'Revocation fixture',
      legalName: 'Revocation fixture company',
      countryCode: 'IT',
    });
    await expect(admin.organization(owner.principal, org.data.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const detail = await admin.organization(f.admin.principal, org.data.id);
    expect(detail.data.members[0]!.user_id).toBe(owner.principal.userId);
    const transfer = await admin.prepareOwnerTransfer(f.admin.principal, org.data.id, {
      fromUserId: owner.principal.userId,
      toUserId: incoming.principal.userId,
      expectedVersion: 1,
      reason,
    });
    await expect(
      admin.revokeOwnership(incoming.principal, transfer.data.id, { reason }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.revokeOwnership(f.admin.principal, transfer.data.id, { reason });
    await expect(
      admin.acceptOwnership(incoming.principal, transfer.data.id, { acceptResponsibilities: true }),
    ).rejects.toMatchObject({ code: 'TRANSFER_EXPIRED' });
    expect((await admin.ownerInvitations(incoming.principal)).data).toHaveLength(0);
    const response = await f.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        url: '/v1/admin/organizations?status=pending',
        headers: { authorization: `Bearer ${f.admin.credentials.token}` },
      });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.every((r: any) => r.status === 'pending')).toBe(true);
  });
});
