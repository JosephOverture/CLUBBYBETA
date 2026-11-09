import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { FastifyRequest } from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { isolatedDatabase } from './database-helper';
import { Database } from '../apps/api/src/platform/database';
import { migrate } from '../apps/api/src/platform/migrations';
import { createApplication } from '../apps/api/src/bootstrap';
import { IdentityService, type Principal } from '../apps/api/src/identity/identity.service';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
import { CatalogueService } from '../apps/api/src/catalogue/catalogue.service';
import { EventsService } from '../apps/api/src/events/events.service';
import { ObjectStore } from '../apps/api/src/media/object-store';
import { MediaService } from '../apps/api/src/media/media.service';
import { JobQueue, platformHandlers } from '../apps/api/src/platform/jobs';
import { openAt, safeExternalUrl, validZonedInstant } from '../apps/api/src/catalogue/catalogue.schemas';
import { PaymentsService } from '../apps/api/src/commerce/payments.service';

describe('catalogue time and URL boundaries', () => {
  it('rejects missing/nonexistent DST local times and accepts both explicit autumn offsets', () => {
    expect(validZonedInstant('2026-03-29T02:30:00+01:00', 'Europe/Rome')).toBe(false);
    expect(validZonedInstant('2026-10-25T02:30:00+02:00', 'Europe/Rome')).toBe(true);
    expect(validZonedInstant('2026-10-25T02:30:00+01:00', 'Europe/Rome')).toBe(true);
  });
  it('handles overnight hours and explicit closed-day exceptions', () => {
    const schedule = {
      weekly: [{ day: 5, intervals: [{ opens: '22:00', closes: '04:00' }] }],
      exceptions: [],
    };
    expect(openAt(schedule, 'Europe/Rome', new Date('2026-09-26T00:30:00Z'))).toBe(true);
    expect(openAt(schedule, 'Europe/Rome', new Date('2026-09-26T03:00:00Z'))).toBe(false);
    expect(
      openAt(
        { ...schedule, exceptions: [{ date: '2026-09-26', intervals: [] }] },
        'Europe/Rome',
        new Date('2026-09-26T00:30:00Z'),
      ),
    ).toBe(false);
  });
  it('allows public HTTPS external checkout but denies credentials, local/IP targets and script schemes', () => {
    expect(safeExternalUrl('https://www.eventbrite.com/e/example')).toBe(true);
    for (const url of [
      'javascript:alert(1)',
      'http://eventbrite.com',
      'https://user:secret@eventbrite.com',
      'https://127.0.0.1',
      'https://[::1]',
      'https://intranet.local',
      'https://example.com:444',
    ])
      expect(safeExternalUrl(url)).toBe(false);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('catalogue/events/media on PostgreSQL', () => {
  let db: Database,
    dispose: () => Promise<void>,
    app: NestFastifyApplication,
    catalogue: CatalogueService,
    events: EventsService,
    media: MediaService,
    organizations: OrganizationsService;
  let directory: string,
    owner: Principal,
    organizer: Principal,
    outsider: Principal,
    admin: Principal,
    org: string,
    organizerOrg: string,
    ownerToken: string;
  const details = {
    name: 'Test Club',
    description: 'A reviewed development venue.',
    latitude: 45.4642,
    longitude: 9.19,
    tags: ['Techno'],
    minimumAge: 18,
    address: 'Test address, Milan',
    contactUrl: null,
    schedule: { weekly: [{ day: 5, intervals: [{ opens: '22:00', closes: '04:00' }] }], exceptions: [] },
  };
  const program = {
    title: 'Development event',
    description: 'A deterministic fixture',
    lineup: ['Development artist'],
    tags: ['Techno'],
    externalUrl: null,
    occurrences: [
      { startsAt: '2030-06-15T23:00:00+02:00', endsAt: '2030-06-16T04:00:00+02:00', capacity: 100 },
    ],
  };
  async function actor(email: string) {
    const id = randomUUID();
    await db.query("INSERT INTO users(id,email,email_verified_at,kind) VALUES($1,$2,now(),'registered')", [
      id,
      email,
    ]);
    const identity = app.get(IdentityService);
    const credentials = await db.transaction((tx) => identity.issue(tx, id, 'ios'));
    const principal = await identity.authenticate({
      method: 'GET',
      headers: { authorization: `Bearer ${credentials.token}` },
      cookies: {},
    } as FastifyRequest);
    return { principal, token: credentials.token };
  }
  beforeAll(async () => {
    ({ db, dispose } = await isolatedDatabase({ APP_ENCRYPTION_KEY: 'c1'.repeat(32), STORAGE_MODE: 'file' }));
    await migrate(db, resolve('database/migrations'));
    directory = await mkdtemp(join(tmpdir(), 'clubby-media-test-'));
    app = await createApplication(db.config, db, { objectStore: new ObjectStore(db.config, directory) });
    catalogue = app.get(CatalogueService);
    events = app.get(EventsService);
    media = app.get(MediaService);
    organizations = app.get(OrganizationsService);
    ({ principal: owner, token: ownerToken } = await actor('catalogue-owner@example.test'));
    ({ principal: admin } = await actor('catalogue-admin@example.test'));
    ({ principal: organizer } = await actor('catalogue-organizer@example.test'));
    ({ principal: outsider } = await actor('catalogue-outsider@example.test'));
    await db.query("INSERT INTO platform_grants(user_id,role) VALUES($1,'admin')", [admin.userId]);
    org = (
      await organizations.apply(owner, { name: 'Venue owner', legalName: 'Owner company', countryCode: 'IT' })
    ).data.id;
    organizerOrg = (
      await organizations.apply(organizer, {
        name: 'Organizer',
        legalName: 'Organizer company',
        countryCode: 'IT',
      })
    ).data.id;
    for (const id of [org, organizerOrg])
      await organizations.review(admin, id, {
        status: 'approved',
        expectedVersion: 1,
        reason: 'Development verification',
      });
    await catalogue.destination(admin, {
      id: 'milan',
      name: 'Milan',
      countryCode: 'IT',
      timezone: 'Europe/Rome',
      currency: 'EUR',
      published: true,
      aliases: ['milano'],
      reason: 'Reviewed development market',
    });
  });
  afterAll(async () => {
    if (app) await app.close();
    else if (db) await db.onApplicationShutdown();
    if (dispose) await dispose();
    if (directory) {
      const checked = resolve(directory);
      if (!checked.startsWith(resolve(tmpdir(), 'clubby-media-test-')))
        throw new Error('Unsafe cleanup path');
      await rm(checked, { recursive: true, force: true });
    }
  });
  it('scopes venue writes and keeps draft venues private', async () => {
    await expect(
      catalogue.createVenue(outsider, {
        ...details,
        id: 'forged',
        organizationId: org,
        destinationId: 'milan',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await catalogue.createVenue(owner, {
      ...details,
      id: 'test-club',
      organizationId: org,
      destinationId: 'milan',
    });
    expect((await app.inject('/v1/venues/test-club')).statusCode).toBe(404);
    const results = await Promise.allSettled(
      [1, 2].map((i) =>
        catalogue.editVenue(owner, 'test-club', { ...details, name: `Revision ${i}`, expectedVersion: 1 }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await catalogue.publishVenue(owner, 'test-club', {
      status: 'published',
      expectedVersion: 2,
      reason: 'Ready for public discovery',
    });
    expect((await app.inject('/v1/venues/test-club')).statusCode).toBe(200);
  });
  it('searches by alias, tag, map bounds and distance with validated pagination', async () => {
    await catalogue.createVenue(owner, {
      ...details,
      id: 'second-club',
      organizationId: org,
      destinationId: 'milan',
      longitude: 9.2,
    });
    await catalogue.publishVenue(owner, 'second-club', {
      status: 'published',
      expectedVersion: 1,
      reason: 'Ready for public discovery',
    });
    const first = await app.inject(
      '/v1/venues?city=milano&tag=Techno&latitude=45.4642&longitude=9.19&limit=1',
    );
    expect(first.statusCode).toBe(200);
    expect(first.json().data[0].id).toBe('test-club');
    expect(first.json().data[0].distanceKm).toBeCloseTo(0, 3);
    const second = await app.inject(
      `/v1/venues?city=milano&tag=Techno&latitude=45.4642&longitude=9.19&limit=1&cursor=${first.json().meta.nextCursor}`,
    );
    expect(second.json().data[0].id).toBe('second-club');
    expect(
      (await app.inject(`/v1/venues?city=milan&cursor=${first.json().meta.nextCursor}`)).statusCode,
    ).toBe(400);
    expect((await app.inject('/v1/venues?city=milan&bbox=9,45,10,46')).json().data).toHaveLength(2);
    expect((await app.inject('/v1/venues?city=milan&query=%27%20OR%201=1')).json().data).toHaveLength(0);
  });
  it('does not duplicate an event when two approval requests race, and preserves proposal revisions', async () => {
    const proposal = await events.propose(organizer, {
      venueId: 'test-club',
      organizationId: organizerOrg,
      event: program,
    });
    await events.reviewProposal(owner, proposal.data.id, {
      decision: 'changes-requested',
      expectedVersion: 1,
      reason: 'Please clarify the published lineup',
    });
    await events.resubmit(organizer, proposal.data.id, {
      event: { ...program, lineup: ['Confirmed development artist'] },
      expectedVersion: 2,
    });
    const responses = await Promise.all(
      [1, 2].map(() =>
        events.reviewProposal(owner, proposal.data.id, {
          decision: 'approved',
          expectedVersion: 3,
          reason: 'Programming and lineup verified',
        }),
      ),
    );
    expect(responses[0]!.data.eventId).toBe(responses[1]!.data.eventId);
    expect((await db.query('SELECT id FROM events WHERE id=$1', [responses[0]!.data.eventId])).rowCount).toBe(
      1,
    );
    expect(
      (await db.query('SELECT id FROM proposal_reviews WHERE proposal_id=$1', [proposal.data.id])).rowCount,
    ).toBe(4);
    expect((await app.inject(`/v1/events/${responses[0]!.data.eventId}`)).json().data[0].lineup).toEqual([
      'Confirmed development artist',
    ]);
    await expect(
      events.publish(organizer, responses[0]!.data.eventId!, {
        status: 'hidden',
        expectedVersion: 1,
        reason: 'Unauthorized venue action',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects invalid dates and records durable event changes in venue time/currency', async () => {
    await expect(
      events.create(owner, {
        ...program,
        venueId: 'test-club',
        occurrences: [
          { startsAt: '2030-03-31T02:30:00+01:00', endsAt: '2030-03-31T04:00:00+02:00', capacity: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_LOCAL_TIME' });
    const event = await events.create(owner, { ...program, venueId: 'test-club' });
    const changed = await events.changeOccurrence(owner, event.data.occurrenceIds[0]!, {
      action: 'reschedule',
      startsAt: '2030-06-16T23:00:00+02:00',
      endsAt: '2030-06-17T04:00:00+02:00',
      expectedVersion: 1,
      reason: 'Approved venue schedule change',
    });
    expect(changed.data!.currency).toBe('EUR');
    expect(changed.data!.timezone).toBe('Europe/Rome');
    const queue = new JobQueue(db, {
      ...platformHandlers,
      'catalogue.changed': app.get(PaymentsService).catalogueChanged,
    });
    // Earlier application notifications may precede this change in the shared outbox.
    for (let attempt = 0; attempt < 20; attempt++) {
      await queue.tick();
      if (
        (
          await db.query('SELECT processed_at FROM catalogue_changes WHERE aggregate_id=$1', [
            event.data.occurrenceIds[0],
          ])
        ).rows[0]?.processed_at
      )
        break;
    }
    expect(
      (
        await db.query('SELECT processed_at FROM catalogue_changes WHERE aggregate_id=$1', [
          event.data.occurrenceIds[0],
        ])
      ).rows[0]?.processed_at,
    ).toBeTruthy();
    await events.changeOccurrence(owner, event.data.occurrenceIds[0]!, {
      action: 'cancel',
      expectedVersion: 2,
      reason: 'Event cancelled by venue',
    });
    expect(
      (await db.query('SELECT status FROM occurrences WHERE id=$1', [event.data.occurrenceIds[0]])).rows[0]
        ?.status,
    ).toBe('cancelled');
  });
  it('keeps externally linked events separate and validates link overrides', async () => {
    const version = (await db.query('SELECT version FROM venues WHERE id=$1', ['test-club'])).rows[0]!
      .version;
    await expect(
      catalogue.commercialMode(admin, 'test-club', {
        mode: 'external',
        externalUrl: 'javascript:alert(1)',
        expectedVersion: version,
        reason: 'Change booking provider',
      }),
    ).rejects.toThrow();
    await catalogue.commercialMode(admin, 'test-club', {
      mode: 'external',
      externalUrl: 'https://www.eventbrite.com/e/clubby-demo',
      expectedVersion: version,
      reason: 'Change booking provider',
    });
    const eventsResult = (await app.inject('/v1/venues/test-club/events')).json();
    expect(eventsResult.data[0].externalUrl).toBe('https://www.eventbrite.com/e/clubby-demo');
    expect(eventsResult.data[0].commercialMode).toBe('external');
  });
  it('synchronizes private saves and hides every public path when a destination is hidden', async () => {
    const saved = await app.inject({
      method: 'POST',
      url: '/v1/me/saved-venues/test-club',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { saved: true },
    });
    expect(saved.statusCode).toBe(201);
    expect(
      (
        await app.inject({ url: '/v1/me/saved-venues', headers: { authorization: `Bearer ${ownerToken}` } })
      ).json().data[0].id,
    ).toBe('test-club');
    await catalogue.destinationVisibility(admin, 'milan', {
      published: false,
      expectedVersion: 1,
      reason: 'Market temporarily hidden',
    });
    expect((await app.inject('/v1/venues/test-club')).statusCode).toBe(404);
    expect((await app.inject('/v1/venues')).json().data).toHaveLength(0);
    expect((await app.inject('/v1/venues/test-club/events')).json().data).toHaveLength(0);
    await catalogue.destinationVisibility(admin, 'milan', {
      published: true,
      expectedVersion: 2,
      reason: 'Market published again',
    });
  });
  it('authorizes upload, verifies real image bytes, strips metadata and protects referenced images', async () => {
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#9933ff' } })
      .png()
      .toBuffer();
    await expect(
      media.create(outsider, 'test-club', {
        contentType: 'image/png',
        bytes: png.length,
        altText: 'Test art',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const asset = await media.create(owner, 'test-club', {
      contentType: 'image/png',
      bytes: png.length,
      altText: 'Test art',
    });
    const upload = await app.inject({
      method: 'PUT',
      url: asset.data.uploadPath,
      headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/octet-stream' },
      payload: png,
    });
    expect(upload.statusCode).toBe(200);
    await media.process({ assetId: asset.data.id });
    await media.process({ assetId: asset.data.id });
    await expect(media.publicImage(asset.data.id, 'hero')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const version = (await db.query('SELECT version FROM venues WHERE id=$1', ['test-club'])).rows[0]!
      .version;
    await media.attach(owner, 'test-club', { assetId: asset.data.id, expectedVersion: version });
    const image = await app.inject(`/v1/media/${asset.data.id}/hero`);
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/webp');
    const metadata = await sharp(image.rawPayload).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.format).toBe('webp');
    await expect(media.remove(owner, asset.data.id)).rejects.toMatchObject({ code: 'MEDIA_IN_USE' });
  });
  it('rejects disguised active content and expires abandoned uploads', async () => {
    const body = Buffer.from('<svg onload="alert(1)"></svg>');
    const asset = await media.create(owner, 'test-club', {
      contentType: 'image/png',
      bytes: body.length,
      altText: 'Disguised image',
    });
    await media.upload(owner, asset.data.id, body);
    await media.process({ assetId: asset.data.id });
    expect(
      (await db.query('SELECT status FROM media_assets WHERE id=$1', [asset.data.id])).rows[0]?.status,
    ).toBe('rejected');
    const abandoned = await media.create(owner, 'test-club', {
      contentType: 'image/png',
      bytes: 10,
      altText: 'Unfinished upload',
    });
    await db.query("UPDATE media_assets SET expires_at=now()-interval '1 second' WHERE id=$1", [
      abandoned.data.id,
    ]);
    await media.expireUploads();
    await media.cleanup({ assetId: abandoned.data.id });
    expect(
      (await db.query('SELECT status FROM media_assets WHERE id=$1', [abandoned.data.id])).rows[0]?.status,
    ).toBe('deleted');
  });
  it('removes bytes written by a late upload after deletion wins the race', async () => {
    const body = Buffer.from('late upload bytes');
    const asset = await media.create(owner, 'test-club', {
      contentType: 'image/png',
      bytes: body.length,
      altText: 'Late upload',
    });
    const original = media.store.put.bind(media.store);
    const write = vi.spyOn(media.store, 'put').mockImplementationOnce(async (key, value, type) => {
      await db.query("UPDATE media_assets SET status='deleted' WHERE id=$1", [asset.data.id]);
      await media.cleanup({ assetId: asset.data.id });
      await original(key, value, type);
    });
    try {
      await expect(media.upload(owner, asset.data.id, body)).rejects.toMatchObject({
        code: 'UPLOAD_EXPIRED',
      });
      await expect(media.store.get(`${asset.data.id}/original`)).rejects.toThrow();
    } finally {
      write.mockRestore();
    }
  });
  it('allows event organizers to use separate event artwork without editing the venue image', async () => {
    const event = (
      await db.query('SELECT id,version FROM events WHERE organization_id=$1 LIMIT 1', [organizerOrg])
    ).rows[0]!;
    const originalHero = (await db.query("SELECT hero_media_id FROM venues WHERE id='test-club'")).rows[0]!
      .hero_media_id;
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#00aa99' } })
      .png()
      .toBuffer();
    const asset = await media.createForEvent(organizer, event.id, {
      contentType: 'image/png',
      bytes: image.length,
      altText: 'Independent event artwork',
    });
    await media.upload(organizer, asset.data.id, image);
    await media.process({ assetId: asset.data.id });
    expect((await media.inspect(organizer, asset.data.id)).data.status).toBe('ready');
    await expect(media.inspect(outsider, asset.data.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await media.attachToEvent(organizer, event.id, {
      assetId: asset.data.id,
      expectedVersion: event.version,
    });
    expect(
      (await db.query("SELECT hero_media_id FROM venues WHERE id='test-club'")).rows[0]!.hero_media_id,
    ).toBe(originalHero);
    expect((await app.inject(`/v1/events/${event.id}`)).json().data[0].heroMediaId).toBe(asset.data.id);
  });
  it('reviews venue ownership claims with version conflicts and an audit trail', async () => {
    await db.query(
      "INSERT INTO venues(id,destination_id,name) VALUES('unclaimed','milan','Unclaimed fixture')",
    );
    const claim = await catalogue.claim(owner, 'unclaimed', {
      organizationId: org,
      evidence: 'Development ownership verification record',
    });
    await expect(
      catalogue.reviewClaim(outsider, claim.data!.id, {
        decision: 'approved',
        expectedVenueVersion: 1,
        reason: 'Claim reviewed',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await catalogue.reviewClaim(admin, claim.data!.id, {
      decision: 'approved',
      expectedVenueVersion: 1,
      reason: 'Claim verified against seller evidence',
    });
    await organizations.authorizeVenue(owner, 'unclaimed', 'venue.edit');
    expect(
      (await db.query('SELECT status FROM venue_claims WHERE id=$1', [claim.data!.id])).rows[0]?.status,
    ).toBe('approved');
  });
});
