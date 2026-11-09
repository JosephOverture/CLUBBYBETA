import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { isolatedDatabase } from './database-helper';
import { PaymentProviderDouble } from './payment-provider-double';
import { migrate } from '../apps/api/src/platform/migrations';
import { createApplication } from '../apps/api/src/bootstrap';
import { IdentityService } from '../apps/api/src/identity/identity.service';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
import { SellersService } from '../apps/api/src/commerce/sellers.service';
import { TablesService } from '../apps/api/src/tables/tables.service';
import type { WalletProvider } from '../apps/api/src/tickets/wallet-provider';
import { activateTestMarket } from './market-fixture';
import type { AppleProvider } from '../apps/api/src/identity/apple-provider';
import type { JWTVerifyGetKey } from 'jose';
export function zoned(date: Date) {
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
    }).formatToParts(date),
    v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}:${v.second}${v.timeZoneName!.replace('GMT', '') || '+00:00'}`;
}
export async function commerceFixture(
  extraEnv: Record<string, string | undefined> = {},
  walletProvider?: WalletProvider,
  appleProvider?: AppleProvider,
  appleNotificationKeys?: JWTVerifyGetKey,
) {
  const { db, dispose } = await isolatedDatabase({
      APP_ENCRYPTION_KEY: 'e2'.repeat(32),
      EMAIL_MODE: 'file',
      STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_fixture',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture',
      STRIPE_WEBHOOK_SECRETS: 'whsec_groups',
      STRIPE_ONBOARDING_ORIGIN: 'http://localhost:8081',
      ...extraEnv,
    }),
    provider = new PaymentProviderDouble();
  await migrate(db, resolve('database/migrations'));
  const app = await createApplication(db.config, db, {
    paymentProvider: provider,
    walletProvider,
    appleProvider,
    appleNotificationKeys,
  });
  async function actor(channel: 'ios' | 'web' = 'ios') {
    const userId = randomUUID(),
      email = `${userId}@example.test`;
    await db.query(
      "INSERT INTO users(id,email,email_verified_at,kind,display_name) VALUES($1,$2,now(),'registered',$3)",
      [userId, email, `Member ${userId.slice(0, 5)}`],
    );
    const identity = app.get(IdentityService),
      credentials = await db.transaction((tx) => identity.issue(tx, userId, channel));
    const principal = await identity.authenticate({
      method: 'GET',
      headers: channel === 'ios' ? { authorization: `Bearer ${credentials.token}` } : {},
      cookies: channel === 'web' ? { clubby_session: credentials.token } : {},
    } as FastifyRequest);
    return { principal, email, credentials };
  }
  const owner = await actor(),
    admin = await actor();
  await db.query("INSERT INTO platform_grants(user_id,role) VALUES($1,'admin')", [admin.principal.userId]);
  const organizations = app.get(OrganizationsService);
  const org = (
    await organizations.apply(owner.principal, {
      name: 'Group venue',
      legalName: 'Group venue legal seller',
      countryCode: 'IT',
    })
  ).data.id;
  await organizations.review(admin.principal, org, {
    status: 'approved',
    expectedVersion: 1,
    reason: 'Verified group commerce fixture',
  });
  await db.query(
    "INSERT INTO destinations(id,name,country_code,timezone,currency,published,native_sales_enabled) VALUES('milan','Milan','IT','Europe/Rome','EUR',true,true)",
  );
  await db.query(
    "INSERT INTO venues(id,destination_id,name,status,organization_id,commercial_mode) VALUES('group-venue','milan','Group venue','published',$1,'native')",
    [org],
  );
  await db.query('UPDATE public_settings SET new_sales_paused=false');
  const sellers = app.get(SellersService),
    policy = await sellers.policy(admin.principal, org, {
      commissionBps: 1250,
      refundCutoffHours: 0,
      refundCommission: true,
      terms: 'Group fixture seller refund and full package commission terms.',
      taxRegistration: 'IT-GROUP-FIXTURE',
      processingFeeBearer: 'seller',
      payoutModel: 'stripe-managed',
      reason: 'Group commerce fixture policy',
    });
  await sellers.accept(owner.principal, org, policy.data.id);
  await sellers.onboard(owner.principal, org);
  await activateTestMarket(db, admin.principal, sellers);
  const tables = app.get(TablesService);
  let version = 0;
  async function offer() {
    const eventId = randomUUID(),
      id = randomUUID(),
      starts = new Date(Math.floor((Date.now() + 86400_000) / 1000) * 1000),
      ends = new Date(starts.getTime() + 4 * 3600_000);
    await db.query(
      "INSERT INTO events(id,venue_id,organization_id,title,status) VALUES($1,'group-venue',$2,'Group event','published')",
      [eventId, org],
    );
    await db.query(
      "INSERT INTO occurrences(id,event_id,starts_at,ends_at,timezone,currency,capacity,status) VALUES($1,$2,$3,$4,'Europe/Rome','EUR',100,'published')",
      [id, eventId, starts, ends],
    );
    const layout = await tables.layout(owner.principal, 'group-venue', {
      name: 'Private group floor',
      zones: [{ id: 'main', label: 'Main room' }],
      tables: [
        {
          label: 'A',
          zoneId: 'main',
          seats: 8,
          x: 0.5,
          y: 0.5,
          width: 0.2,
          height: 0.2,
          rotation: 0,
          shape: 'circle',
        },
      ],
      expectedVersion: version,
      reason: 'Group test physical table',
    });
    version = layout.data.version;
    await tables.pin(owner.principal, id, {
      layoutId: layout.data.id,
      expectedVersion: 0,
      reason: 'Pin group fixture floor plan',
    });
    const offer = await tables.offer(owner.principal, id, {
      tableId: layout.data.content.tables[0]!.id,
      slotStartsAt: zoned(starts),
      slotEndsAt: zoned(ends),
      minGuests: 2,
      maxGuests: 8,
      fullPriceMinor: 10000,
      depositMinor: 3000,
      taxBps: 2200,
      drinksPerGuest: 1,
      inclusions: 'Reserved table with package credit and admissions',
      minimumSpendMinor: 10000,
      terms: 'Full group cancellation before the event. No-show payments are retained.',
      noShowAfterMinutes: 15,
      noShowPolicy: 'retain-paid',
      active: true,
    });
    return {
      offerId: offer.data.id,
      occurrenceId: id,
      starts,
      ends,
      tableId: layout.data.content.tables[0]!.id,
    };
  }
  return {
    db,
    app,
    provider,
    owner,
    admin,
    org,
    actor,
    offer,
    async close() {
      await app.close();
      await dispose();
    },
  };
}
