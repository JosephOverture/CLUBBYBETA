import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { commerceFixture } from './commerce-fixture';
import { InventoryService } from '../apps/api/src/commerce/inventory.service';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
describe.skipIf(!process.env.TEST_DATABASE_URL)('seller workspace authorization and discovery', () => {
  let f: Awaited<ReturnType<typeof commerceFixture>>;
  beforeAll(async () => {
    f = await commerceFixture();
  });
  afterAll(async () => {
    if (f) await f.close();
  });
  it('paginates upcoming occurrences with microsecond timestamps without repeating the last page', async () => {
    const event = randomUUID();
    await f.db.query(
      "INSERT INTO events(id,venue_id,organization_id,title,status) VALUES($1,'group-venue',$2,'Paged schedule','published')",
      [event, f.org],
    );
    await f.db.query(
      "INSERT INTO occurrences(id,event_id,starts_at,ends_at,timezone,currency,capacity,status) SELECT gen_random_uuid(),$1,'2028-01-01 20:00:00.123456+00'::timestamptz,'2028-01-02 02:00:00.123456+00'::timestamptz,'Europe/Rome','EUR',100,'published' FROM generate_series(1,105)",
      [event],
    );
    const first = await f.app.inject('/v1/venues/group-venue/events');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data).toHaveLength(100);
    const cursor = first.json().meta.nextCursor;
    const second = await f.app.inject('/v1/venues/group-venue/events?cursor=' + encodeURIComponent(cursor));
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data).toHaveLength(5);
    const ids = [...first.json().data, ...second.json().data].map((r) => r.occurrenceId);
    expect(new Set(ids).size).toBe(105);
    expect(second.json().meta.nextCursor).toBeNull();
    expect(
      (await f.app.inject('/v1/venues/another/events?cursor=' + encodeURIComponent(cursor))).statusCode,
    ).toBe(400);
  });
  const headers = (user: Awaited<ReturnType<typeof f.actor>>) => ({
    authorization: `Bearer ${user.credentials.token}`,
  });
  it('lists draft and published resources with tenant and venue scope on every page', async () => {
    await f.offer();
    const person = await f.actor();
    await f.db.query(
      "INSERT INTO memberships(id,organization_id,user_id,role,venue_ids) VALUES($1,$2,$3,'editor',ARRAY['group-venue'])",
      [randomUUID(), f.org, person.principal.userId],
    );
    await f.db.query(
      "INSERT INTO venues(id,name,destination_id,organization_id) SELECT 'workspace-'||lpad(i::text,3,'0'),'Draft '||i,'milan',$1 FROM generate_series(1,51) i",
      [f.org],
    );
    const first = await f.app.inject({ url: `/v1/organizations/${f.org}/venues`, headers: headers(f.owner) });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toHaveLength(50);
    const next = await f.app.inject({
      url: `/v1/organizations/${f.org}/venues?before=${first.json().meta.nextCursor}`,
      headers: headers(f.owner),
    });
    expect(next.json().data).toHaveLength(2);
    expect(next.json().meta.nextCursor).toBeNull();
    const scoped = await f.app.inject({ url: `/v1/organizations/${f.org}/venues`, headers: headers(person) });
    expect(scoped.json().data.map((r: any) => r.id)).toEqual(['group-venue']);
    expect(
      (await f.app.inject({ url: `/v1/organizations/${f.org}/events`, headers: headers(person) })).json().data
        .length,
    ).toBeGreaterThan(0);
    const stranger = await f.actor();
    for (const suffix of ['venues', 'events', 'proposals', 'invitations', 'promotions', 'members'])
      expect(
        (await f.app.inject({ url: `/v1/organizations/${f.org}/${suffix}`, headers: headers(stranger) }))
          .statusCode,
      ).toBe(403);
  });
  it('paginates staff without leaking identity credentials and enforces owner access', async () => {
    const other = await f.actor();
    const response = await f.app.inject({
      url: `/v1/organizations/${f.org}/members`,
      headers: headers(f.owner),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.length).toBeGreaterThan(0);
    const member = response.json().data.find((m: any) => m.user_id === f.owner.principal.userId);
    expect(member.email).toBe(f.owner.email);
    expect(member).toHaveProperty('displayName');
    expect(response.body).not.toContain('token');
    expect(response.json().meta).toHaveProperty('nextCursor');
    expect(
      (await f.app.inject({ url: `/v1/organizations/${f.org}/members`, headers: headers(other) })).statusCode,
    ).toBe(403);
  });
  it('drives draft creation, publication and inventory editing with the seller screen payloads', async () => {
    const h = headers(f.owner),
      venueId = `journey-${randomUUID()}`;
    const send = async (url: string, payload: unknown, expected = 201) => {
      const result = await f.app.inject({ method: 'POST', url, payload: payload as any, headers: h });
      expect(result.statusCode, result.body).toBe(expected);
      return result.json().data;
    };
    const venue = {
      name: 'Workspace journey venue',
      description: 'Live music and dancing',
      latitude: 45.46,
      longitude: 9.19,
      tags: ['dance'],
      minimumAge: 18,
      address: 'Via Test 1',
      contactUrl: null,
      schedule: { weekly: [{ day: 5, intervals: [{ opens: '22:00', closes: '04:00' }] }], exceptions: [] },
    };
    await send('/v1/seller/venues', { ...venue, id: venueId, organizationId: f.org, destinationId: 'milan' });
    const edited = await send(`/v1/seller/venues/${venueId}`, {
      ...venue,
      name: 'Updated venue',
      expectedVersion: 1,
    });
    expect(edited.version).toBe(2);
    await send(`/v1/seller/venues/${venueId}`, { ...venue, expectedVersion: 1 }, 409);
    await send(`/v1/seller/venues/${venueId}/publication`, {
      status: 'published',
      expectedVersion: 2,
      reason: 'Reviewed public venue information',
    });
    const event = await send('/v1/seller/events', {
      venueId,
      title: 'Winter party',
      description: 'Dance all night',
      lineup: ['Artist'],
      tags: ['dance'],
      externalUrl: null,
      occurrences: [
        { startsAt: '2028-12-01T22:00:00+01:00', endsAt: '2028-12-02T04:00:00+01:00', capacity: 100 },
      ],
    });
    await send(`/v1/seller/events/${event.id}/publication`, {
      status: 'published',
      expectedVersion: 1,
      reason: 'Host reviewed event details',
    });
    const occurrenceId = event.occurrenceIds[0];
    const product = {
      name: 'General admission',
      priceMinor: 2500,
      taxBps: 2200,
      capacity: 80,
      drinks: 1,
      admissionConditions: '18+ with valid ID',
      extraDrinkPriceMinor: 500,
      extraDrinkLimit: 2,
      extraDrinkTaxBps: 2200,
      saleStartsAt: '2028-01-01T00:00:00+01:00',
      saleEndsAt: '2028-12-01T22:00:00+01:00',
      active: true,
    };
    const created = await send(`/v1/seller/occurrences/${occurrenceId}/products`, product);
    await send(`/v1/seller/occurrences/${occurrenceId}/products/${created.id}`, {
      ...product,
      priceMinor: 2800,
      expectedVersion: created.version,
    });
    const inventory = await f.app.inject({
      url: `/v1/seller/occurrences/${occurrenceId}/inventory`,
      headers: h,
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json().data.products[0]).toMatchObject({ price_minor: 2800, version: 2, committed: 0 });
    const block = await send(`/v1/seller/occurrences/${occurrenceId}/blocks`, {
      quantity: 10,
      reason: 'Reserved for production team',
    });
    await send(`/v1/seller/occurrences/${occurrenceId}/blocks`, {
      quantity: 10,
      releaseId: block.id,
      reason: 'Production team released seats',
    });
    const hosted = await f.app.inject({ url: `/v1/seller/venues/${venueId}/proposals`, headers: h });
    expect(hosted.statusCode).toBe(200);
    expect(hosted.json()).toMatchObject({ data: [], meta: { nextCursor: null } });
    const outside = await f.actor();
    expect(
      (await f.app.inject({ url: `/v1/seller/events/${event.id}/media`, headers: headers(outside) }))
        .statusCode,
    ).toBe(403);
    expect(
      (await f.app.inject({ url: `/v1/seller/events/${event.id}/media`, headers: h })).json().data,
    ).toEqual([]);
  });
  it('exposes configuration rather than customer data and rejects finance-only editors', async () => {
    const offer = await f.offer(),
      finance = await f.actor(),
      outside = await f.actor();
    await f.db.query("INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'finance')", [
      randomUUID(),
      f.org,
      finance.principal.userId,
    ]);
    const path = `/v1/seller/occurrences/${offer.occurrenceId}/inventory`;
    const response = await f.app.inject({ url: path, headers: headers(f.owner) });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.tableOffers).toHaveLength(1);
    expect(response.json().data.layout.content.tables.length).toBeGreaterThan(0);
    expect(response.body).not.toContain('buyer_email');
    for (const user of [finance, outside])
      expect((await f.app.inject({ url: path, headers: headers(user) })).statusCode).toBe(403);
  });
  it('lists invitations without exposing bearer codes and permits only the owner to change promotion status', async () => {
    const orgs = f.app.get(OrganizationsService),
      editor = await f.actor();
    await orgs.invite(f.owner.principal, f.org, { email: editor.email, role: 'editor' });
    const invites = await f.app.inject({
      url: `/v1/organizations/${f.org}/invitations`,
      headers: headers(f.owner),
    });
    expect(invites.statusCode).toBe(200);
    expect(invites.body).toContain(editor.email);
    expect(invites.body).not.toContain('token');
    const promotion = await f.app.get(InventoryService).promotion(f.owner.principal, f.org, {
      code: 'WORKSPACE',
      discountBps: 1500,
      maxUses: 10,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const listing = await f.app.inject({
      url: `/v1/organizations/${f.org}/promotions`,
      headers: headers(f.owner),
    });
    expect(listing.json().data[0]).toMatchObject({
      id: promotion.data.id,
      active: true,
      version: 1,
      committed_uses: 0,
    });
    const command = {
      method: 'POST' as const,
      url: `/v1/organizations/${f.org}/promotions/${promotion.data.id}/status`,
      payload: { active: false, expectedVersion: 1, reason: 'Seasonal campaign has finished' },
    };
    expect((await f.app.inject({ ...command, headers: headers(editor) })).statusCode).toBe(403);
    expect((await f.app.inject({ ...command, headers: headers(f.owner) })).statusCode).toBe(201);
    expect((await f.app.inject({ ...command, headers: headers(f.owner) })).statusCode).toBe(409);
  });
  it('versions editorial changes, hides removed placements and limits claim evidence to authorized reviewers', async () => {
    await f.offer();
    const h = headers(f.admin),
      other = await f.actor();
    const input = {
      venueId: 'group-venue',
      rank: 0,
      startsAt: new Date(Date.now() - 60000).toISOString(),
      endsAt: new Date(Date.now() + 86400000).toISOString(),
      expectedVersion: 0,
      reason: 'Curated weekly venue selection',
    };
    const create = () =>
      f.app.inject({ method: 'POST', url: '/v1/admin/editorial', headers: h, payload: input });
    expect((await create()).statusCode).toBe(201);
    expect((await create()).statusCode).toBe(409);
    expect(
      (await f.app.inject({ url: '/v1/discover' }))
        .json()
        .data.editorial.some((v: any) => v.id === 'group-venue'),
    ).toBe(true);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/admin/editorial/group-venue/remove',
          headers: h,
          payload: { expectedVersion: 1, reason: 'Campaign has finished' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await f.app.inject({ url: '/v1/discover' }))
        .json()
        .data.editorial.some((v: any) => v.id === 'group-venue'),
    ).toBe(false);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/admin/editorial',
          headers: h,
          payload: { ...input, expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/admin/editorial',
          headers: h,
          payload: { ...input, expectedVersion: 2 },
        })
      ).statusCode,
    ).toBe(201);
    const claim = await f.app.inject({
      method: 'POST',
      url: '/v1/venues/group-venue/claims',
      headers: headers(f.owner),
      payload: { organizationId: f.org, evidence: 'Operating contract verified by the business owner.' },
    });
    expect(claim.statusCode).toBe(201);
    const queue = await f.app.inject({ url: '/v1/admin/venue-claims', headers: h });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().data[0]).toMatchObject({
      id: claim.json().data.id,
      venue_name: expect.any(String),
      venue_version: expect.any(Number),
      organization_name: expect.any(String),
    });
    for (const path of [
      '/v1/admin/editorial',
      '/v1/admin/venue-claims',
      `/v1/organizations/${f.org}/venue-claims`,
    ])
      expect((await f.app.inject({ url: path, headers: headers(other) })).statusCode).toBe(403);
    const own = await f.app.inject({
      url: `/v1/organizations/${f.org}/venue-claims`,
      headers: headers(f.owner),
    });
    expect(own.statusCode).toBe(200);
    expect(own.body).not.toContain('Operating contract');
  });
});
