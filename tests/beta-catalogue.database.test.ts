import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { venueListSchema } from '@clubby/contracts';
import sourceVenues from '../database/seeds/milan-venues.json' with { type: 'json' };
import { seedCatalogue } from '../scripts/seed-catalogue';
import { createApplication } from '../apps/api/src/bootstrap';
import { Database } from '../apps/api/src/platform/database';
import { migrate } from '../apps/api/src/platform/migrations';
import { isolatedDatabase } from './database-helper';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Milan beta catalogue through PostgreSQL and HTTP', () => {
  let db: Database, app: NestFastifyApplication, dispose: () => Promise<void>;
  let normalizeVenue: (venue: Record<string, unknown>) => Record<string, unknown>;
  beforeAll(async () => {
    ({ db, dispose } = await isolatedDatabase());
    await migrate(db, resolve('database/migrations'));
    await db.transaction(seedCatalogue);
    app = await createApplication(db.config, db);
    ({ normalizeVenue } = await import(pathToFileURL(resolve('web/src/domain/model.js')).href));
  });
  afterAll(async () => {
    if (app) await app.close();
    else if (db) await db.onApplicationShutdown();
    if (dispose) await dispose();
  });

  it('serves all 28 venues through the Milano alias with exact beta presentation fields', async () => {
    const response = await app.inject('/v1/venues?city=milano&limit=100');
    expect(response.statusCode).toBe(200);
    const body = venueListSchema.parse(response.json());
    expect(body.meta?.nextCursor).toBeNull();
    expect(body.data).toHaveLength(28);
    expect(body.data.map((venue) => venue.id).sort()).toEqual(sourceVenues.map((venue) => venue.id).sort());
    for (const source of sourceVenues) {
      const actual = body.data.find((venue) => venue.id === source.id)!;
      expect(actual).toMatchObject({
        id: source.id,
        name: source.name,
        description: source.description,
        address: source.address,
        latitude: source.latitude,
        longitude: source.longitude,
        genres: source.genres,
        tags: source.genres,
        category: source.category,
        neighbourhood: source.neighbourhood,
        image: source.image,
        tagline: source.tagline,
        pick: source.pick,
        sourceUrl: source.sourceUrl,
        calendarUrl: 'calendarUrl' in source ? source.calendarUrl : null,
        coordinateAccuracy: source.coordinateAccuracy,
        verifiedAt: source.verifiedAt,
        accessNote: 'accessNote' in source ? source.accessNote : null,
        linkType: 'linkType' in source ? source.linkType : null,
        externalUrl: source.externalUrl,
        cityId: 'milan',
        timezone: 'Europe/Rome',
        currency: 'EUR',
        commercialMode: 'external',
        demo: false,
      });
      expect(normalizeVenue(actual)).toMatchObject({
        category: source.category,
        neighbourhood: source.neighbourhood,
        genres: source.genres,
        image: source.image,
        externalUrl: new URL(source.externalUrl).href,
        sourceUrl: new URL(source.sourceUrl).href,
      });
      const detail = await app.inject(`/v1/venues/${source.id}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().data).toMatchObject({ id: source.id, image: source.image, genres: source.genres });
    }
  });

  it('is repeatable and preserves every existing seller edit', async () => {
    await db.query(`UPDATE venues SET name='Rita seller revision',description='Edited by the venue',
      address='Updated seller address',version=7,tags=ARRAY['Seller tag'],genres=ARRAY['Seller genre'],
      discovery_details='{"category":"Seller category","image":"assets/nightlife.svg"}'
      WHERE id='rita'`);
    const before = (await db.query('SELECT * FROM venues ORDER BY id')).rows;
    await db.transaction(seedCatalogue);
    await db.transaction(seedCatalogue);
    expect((await db.query('SELECT * FROM venues ORDER BY id')).rows).toEqual(before);
    expect((await app.inject('/v1/venues?city=milano&limit=100')).json().data).toHaveLength(28);
  });

  it('upgrades only the unchanged legacy Alcatraz demo fixture', async () => {
    // This is the exact row produced by the old development seed. It predates
    // discovery metadata and must no longer shadow the real beta venue.
    await db.query(`UPDATE venues SET name='Alcatraz',description='Development fixture; venue details are unverified.',address='',latitude=NULL,longitude=NULL,
      external_url=NULL,tags='{}',genres='{}',discovery_details='{}',last_verified_at=NULL,
      version=1,demo=true,commercial_mode='native',status='published',organization_id=NULL
      WHERE id='alcatraz'`);
    await db.transaction(seedCatalogue);
    const source = sourceVenues.find((venue) => venue.id === 'alcatraz')!;
    const detail = await app.inject('/v1/venues/alcatraz');
    expect(detail.statusCode).toBe(200);
    expect(normalizeVenue(detail.json().data)).toMatchObject({
      name: source.name,
      address: source.address,
      description: source.description,
      externalUrl: source.externalUrl,
      image: source.image,
      demo: false,
    });

    // Even an older demo-marked row is seller data once someone has edited it.
    await db.query(`UPDATE venues SET demo=true,name='Seller-maintained Alcatraz',description='Seller copy',
      version=9 WHERE id='alcatraz'`);
    const edited = (await db.query("SELECT * FROM venues WHERE id='alcatraz'")).rows[0];
    await db.transaction(seedCatalogue);
    expect((await db.query("SELECT * FROM venues WHERE id='alcatraz'")).rows[0]).toEqual(edited);
  });
});
