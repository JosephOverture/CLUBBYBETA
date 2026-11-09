import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../apps/api/src/platform/database';
import { migrate } from '../apps/api/src/platform/migrations';
import { isolatedDatabase } from './database-helper';

describe.skipIf(!process.env.TEST_DATABASE_URL)('ingestion pipeline schema (020) + enrichment (021)', () => {
  let db: Database;
  let dispose: () => Promise<void>;
  const venueId = 'ingest-venue';
  const orgId = randomUUID();
  const eventId = randomUUID();

  beforeAll(async () => {
    ({ db, dispose } = await isolatedDatabase());
    await migrate(db, resolve('database/migrations'));
    await db.query(
      `INSERT INTO destinations(id,name,country_code,timezone,currency,published)
       VALUES('milan','Milan','IT','Europe/Rome','EUR',true)`,
    );
    await db.query(`INSERT INTO venues(id,destination_id,name,status,demo) VALUES($1,'milan','Ingest Venue','published',true)`, [venueId]);
    await db.query(`INSERT INTO organizations(id,name,country_code) VALUES($1,'Org','IT')`, [orgId]);
    await db.query(`INSERT INTO events(id,venue_id,organization_id,title) VALUES($1,$2,$3,'Night')`, [eventId, venueId, orgId]);
    await db.query(
      `INSERT INTO occurrences(id,event_id,starts_at,ends_at,timezone,currency,capacity)
       VALUES($1,$2,now()+interval '2 days',now()+interval '2 days 6 hours','Europe/Rome','EUR',500)`,
      [randomUUID(), eventId],
    );
  });

  afterAll(async () => {
    if (dispose) await dispose();
    else if (db) await db.onApplicationShutdown();
  });

  it('applies enrichment defaults on existing tables', async () => {
    const v = await db.query<{ operational_status: string; genres: string[] }>(
      'SELECT operational_status, genres FROM venues WHERE id=$1',
      [venueId],
    );
    expect(v.rows[0]?.operational_status).toBe('unknown');
    expect(v.rows[0]?.genres).toEqual([]);
    const o = await db.query<{ lifecycle_status: string; sold_out: boolean; door_time: string | null }>(
      'SELECT lifecycle_status, sold_out, door_time FROM occurrences WHERE event_id=$1',
      [eventId],
    );
    expect(o.rows[0]?.lifecycle_status).toBe('active');
    expect(o.rows[0]?.sold_out).toBe(false);
    expect(o.rows[0]?.door_time).toBeNull();
  });

  it('records sources and enforces their uniqueness', async () => {
    const insert = () =>
      db.query(
        `INSERT INTO venue_sources(id,venue_id,source_type,source_url,provider)
         VALUES($1,$2,'official_api','https://api.example/venue','ExampleAPI')`,
        [randomUUID(), venueId],
      );
    await insert();
    await expect(insert()).rejects.toThrow(); // UNIQUE(venue_id, source_type, source_url)
  });

  it('keeps raw snapshots and observations append-only', async () => {
    const snap = await db.query<{ id: string }>(
      `INSERT INTO raw_snapshots(source_url,source_type,content_hash,body,fetched_at)
       VALUES('https://api.example/venue','official_api',repeat('a',64),'<html/>',now()) RETURNING id`,
    );
    const snapId = snap.rows[0]?.id;
    expect(snapId).toBeTruthy();
    await expect(
      db.query('UPDATE raw_snapshots SET body=$2 WHERE id=$1', [snapId, 'tampered']),
    ).rejects.toThrow(); // append-only trigger
    await db.query(
      `INSERT INTO venue_observations(venue_id,field,value,confidence,model,snapshot_id)
       VALUES($1,'operationalStatus','"active"'::jsonb,0.9,'fake-1',$2)`,
      [venueId, snapId],
    );
    await expect(
      db.query(
        `INSERT INTO venue_observations(venue_id,field,value,confidence) VALUES($1,'x','1'::jsonb,2)`,
        [venueId],
      ),
    ).rejects.toThrow(); // confidence must be within 0..1
  });

  it('maps external ids uniquely for dedup/idempotency', async () => {
    const insert = () =>
      db.query(
        `INSERT INTO external_entity_mappings(entity_type,entity_id,provider,external_id)
         VALUES('event',$1,'eventbrite','EB-123')`,
        [eventId],
      );
    await insert();
    await expect(insert()).rejects.toThrow(); // UNIQUE(provider, external_id, entity_type)
  });

  it('queues review candidates and records ingestion runs', async () => {
    await db.query(
      `INSERT INTO review_queue(id,entity_type,entity_id,candidate,reason,confidence)
       VALUES($1,'venue',$2,'{"name":"Maybe"}'::jsonb,'conflicting-sources',0.5)`,
      [randomUUID(), venueId],
    );
    const pending = await db.query<{ status: string }>(
      'SELECT status FROM review_queue WHERE entity_id=$1',
      [venueId],
    );
    expect(pending.rows[0]?.status).toBe('pending');

    const runId = randomUUID();
    await db.query(
      `INSERT INTO ingestion_runs(id,agent,kind,status,items_found,provider,model,cost)
       VALUES($1,'event-extraction','extract','success',3,'claude','claude-3-5-haiku-latest',0.02)`,
      [runId],
    );
    await db.query(
      `INSERT INTO ingestion_failures(run_id,message,retryable) VALUES($1,'rate limited',true)`,
      [runId],
    );
    const run = await db.query<{ status: string; items_found: number }>(
      'SELECT status, items_found FROM ingestion_runs WHERE id=$1',
      [runId],
    );
    expect(run.rows[0]?.status).toBe('success');
    expect(Number(run.rows[0]?.items_found)).toBe(3);
  });
});
