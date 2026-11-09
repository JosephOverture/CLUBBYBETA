import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { idSchema, venueListSchema, venueResponseSchema } from '@clubby/contracts';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { Public } from '../identity/session.guard';
import { openAt, scheduleSchema } from './catalogue.schemas';

const projection = `SELECT v.id,v.name,v.description,v.destination_id AS "cityId", d.timezone,d.currency,
  v.commercial_mode AS "commercialMode",CASE WHEN v.commercial_mode='external' THEN v.external_url ELSE NULL END AS "externalUrl",v.version,v.demo,
  v.latitude,v.longitude,v.tags,v.minimum_age AS "minimumAge",v.address,v.hero_media_id AS "heroMediaId",v.schedule,
  v.genres,v.discovery_details->>'category' AS category,v.discovery_details->>'neighbourhood' AS neighbourhood,
  v.discovery_details->>'image' AS image,v.discovery_details->>'tagline' AS tagline,v.discovery_details->>'pick' AS pick,
  v.discovery_details->>'sourceUrl' AS "sourceUrl",v.discovery_details->>'calendarUrl' AS "calendarUrl",
  v.discovery_details->>'coordinateAccuracy' AS "coordinateAccuracy",to_char(v.last_verified_at,'YYYY-MM-DD') AS "verifiedAt",
  v.discovery_details->>'accessNote' AS "accessNote",v.discovery_details->>'linkType' AS "linkType"
  FROM venues v JOIN destinations d ON d.id=v.destination_id
  WHERE v.status='published' AND d.published=true`;

@Controller('v1/venues')
@Public()
export class CatalogueController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get()
  async list(@Query() raw: unknown) {
    const input = z
      .object({
        city: idSchema.default('milan'),
        query: z.string().trim().max(80).optional(),
        tag: z.string().max(50).optional(),
        latitude: z.coerce.number().min(-90).max(90).optional(),
        longitude: z.coerce.number().min(-180).max(180).optional(),
        radiusKm: z.coerce.number().positive().max(500).default(50),
        bbox: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        cursor: z.string().max(1000).optional(),
      })
      .strict()
      .parse(raw);
    const nearby = input.latitude !== undefined || input.longitude !== undefined;
    if (nearby && (input.latitude === undefined || input.longitude === undefined))
      throw new ApiError('INVALID_LOCATION', 'Latitude and longitude must be supplied together.', 400);
    const values: unknown[] = [input.city];
    const conditions = ['d.id=COALESCE((SELECT destination_id FROM destination_aliases WHERE alias=$1),$1)'];
    const add = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (input.query) {
      const ref = add(input.query);
      conditions.push(
        `to_tsvector('simple',v.name || ' ' || v.description) @@ plainto_tsquery('simple',${ref})`,
      );
    }
    if (input.tag) conditions.push(`${add(input.tag)}=ANY(v.tags)`);
    if (input.bbox) {
      const box = z.array(z.number().finite()).length(4).parse(input.bbox.split(',').map(Number));
      const [west, south, east, north] = box as [number, number, number, number];
      if (
        west < -180 ||
        west > 180 ||
        east < -180 ||
        east > 180 ||
        south < -90 ||
        north > 90 ||
        south >= north
      )
        throw new ApiError('INVALID_BOUNDS', 'Map bounds are invalid.', 400);
      const w = add(west),
        e = add(east);
      conditions.push(
        `(v.longitude>=${w} ${west > east ? 'OR' : 'AND'} v.longitude<=${e})`,
        `v.latitude BETWEEN ${add(south)} AND ${add(north)}`,
      );
    }
    let distance = 'NULL::double precision';
    if (nearby) {
      const lat = add(input.latitude),
        lon = add(input.longitude);
      conditions.push('v.latitude IS NOT NULL AND v.longitude IS NOT NULL');
      distance = `6371.0088 * 2 * asin(sqrt(least(1.0,power(sin(radians(v.latitude-${lat})/2),2)+cos(radians(${lat}))*cos(radians(v.latitude))*power(sin(radians(v.longitude-${lon})/2),2))))`;
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ ...input, cursor: undefined, limit: undefined }))
      .digest('hex')
      .slice(0, 16);
    let decoded: unknown;
    if (input.cursor) {
      try {
        decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      } catch {
        throw new ApiError('INVALID_CURSOR', 'Malformed search cursor.', 400);
      }
    }
    const cursor = decoded
      ? z.object({ id: idSchema, distance: z.number().nullable(), fingerprint: z.string() }).parse(decoded)
      : undefined;
    if (cursor && cursor.fingerprint !== fingerprint)
      throw new ApiError('INVALID_CURSOR', 'Cursor belongs to a different search.', 400);
    const extra: string[] = [];
    if (nearby) extra.push(`"distanceKm"<=${add(input.radiusKm)}`);
    if (cursor) {
      if (nearby && cursor.distance === null)
        throw new ApiError('INVALID_CURSOR', 'Invalid distance cursor.', 400);
      extra.push(
        nearby ? `("distanceKm",id)>(${add(cursor.distance)},${add(cursor.id)})` : `id>${add(cursor.id)}`,
      );
    }
    const inner = projection.replace('v.schedule', `v.schedule,${distance} AS "distanceKm"`);
    const result = await this.db.query(
      `WITH candidates AS (${inner} AND ${conditions.join(' AND ')}) SELECT * FROM candidates ${extra.length ? `WHERE ${extra.join(' AND ')}` : ''} ORDER BY ${nearby ? '"distanceKm",' : ''}id LIMIT ${add(input.limit + 1)}`,
      values,
    );
    const rows = result.rows.slice(0, input.limit),
      last = rows.at(-1);
    return venueListSchema.parse({
      data: rows.map((row) => ({
        ...row,
        openNow: openAt(scheduleSchema.parse(row.schedule), row.timezone, new Date()),
      })),
      meta: {
        nextCursor:
          result.rows.length > input.limit && last
            ? Buffer.from(JSON.stringify({ id: last.id, distance: last.distanceKm, fingerprint })).toString(
                'base64url',
              )
            : null,
      },
    });
  }
  @Get(':id')
  async detail(@Param('id') rawId: string) {
    const result = await this.db.query(`${projection} AND v.id=$1`, [idSchema.parse(rawId)]);
    if (!result.rows[0]) throw new ApiError('NOT_FOUND', 'Venue not found.', 404);
    const row = result.rows[0];
    return venueResponseSchema.parse({
      data: { ...row, openNow: openAt(scheduleSchema.parse(row.schedule), row.timezone, new Date()) },
    });
  }
}
