import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import type { Principal } from '../identity/identity.service';
import { ObjectStore } from './object-store';
import { enqueue } from '../platform/jobs';
import { revision } from '../catalogue/catalogue.service';
import type { PoolClient } from 'pg';

export class MediaService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
    readonly store: ObjectStore,
  ) {}
  private async authorizeAsset(
    actor: Principal,
    asset: { venue_id: string; event_id?: string | null },
    tx?: PoolClient,
  ) {
    if (asset.event_id) {
      const event = tx
        ? (await tx.query('SELECT organization_id,venue_id FROM events WHERE id=$1', [asset.event_id]))
            .rows[0]
        : (await this.db.query('SELECT organization_id,venue_id FROM events WHERE id=$1', [asset.event_id]))
            .rows[0];
      if (!event || event.venue_id !== asset.venue_id)
        throw new ApiError('INVALID_SCOPE', 'Image event and venue do not match.', 400);
      try {
        await this.organizations.authorize(
          actor,
          event.organization_id,
          'event.edit',
          asset.venue_id,
          false,
          tx,
        );
        return;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'FORBIDDEN') throw error;
      }
    }
    await this.organizations.authorizeVenue(actor, asset.venue_id, 'venue.edit', tx);
  }
  async create(actor: Principal, venueId: string, raw: unknown, eventId?: string) {
    if (this.store.config.STORAGE_MODE === 'disabled')
      throw new ApiError('NOT_CONFIGURED', 'Media storage is unavailable.', 503);
    const input = z
      .object({
        contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        bytes: z
          .number()
          .int()
          .positive()
          .max(5 * 1024 * 1024),
        altText: z.string().trim().min(1).max(500),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await this.authorizeAsset(actor, { venue_id: venueId, event_id: eventId }, tx);
      const id = randomUUID();
      await tx.query(
        'INSERT INTO media_assets(id,venue_id,event_id,actor_id,content_type,max_bytes,alt_text) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, venueId, eventId ?? null, actor.userId, input.contentType, input.bytes, input.altText],
      );
      return {
        data: {
          id,
          uploadPath: `/v1/media/${id}/content`,
          method: 'PUT',
          contentType: 'application/octet-stream',
        },
      };
    });
  }
  async upload(actor: Principal, id: string, body: unknown) {
    if (!Buffer.isBuffer(body)) throw new ApiError('INVALID_MEDIA', 'Upload binary image bytes.', 400);
    const digest = createHash('sha256').update(body).digest('hex');
    const asset = await this.db.transaction(async (tx) => {
      const selected = await tx.query(
        'SELECT *,(expires_at>now()) AS valid FROM media_assets WHERE id=$1 FOR UPDATE',
        [id],
      );
      const row = selected.rows[0];
      if (!row) throw new ApiError('NOT_FOUND', 'Upload not found.', 404);
      await this.authorizeAsset(actor, row, tx);
      if (row.status === 'deleted' || row.status === 'rejected' || (!row.valid && row.status === 'pending'))
        throw new ApiError('UPLOAD_EXPIRED', 'Create a new upload.', 409);
      if (body.length !== row.max_bytes)
        throw new ApiError('INVALID_MEDIA_SIZE', 'Image size differs from the authorized upload.', 400);
      if (row.original_hash && row.original_hash !== digest)
        throw new ApiError('CONFLICT', 'An upload cannot be replaced with different bytes.', 409);
      await tx.query('UPDATE media_assets SET original_hash=$1 WHERE id=$2', [digest, id]);
      return row;
    });
    if (asset.status === 'ready') return { data: { id, status: 'ready' } };
    await this.store.put(`${id}/original`, body, 'application/octet-stream');
    await this.db.transaction(async (tx) => {
      await tx.query("UPDATE media_assets SET status='processing' WHERE id=$1 AND status='pending'", [id]);
      await enqueue(tx, 'media.process', id, { assetId: id });
    });
    if (
      (await this.db.query('SELECT status FROM media_assets WHERE id=$1', [id])).rows[0]?.status === 'deleted'
    ) {
      await this.cleanup({ assetId: id });
      throw new ApiError('UPLOAD_EXPIRED', 'The upload was deleted before it completed.', 409);
    }
    return { data: { id, status: 'processing' } };
  }
  async process(raw: unknown) {
    const { assetId: id } = z.object({ assetId: z.string().uuid() }).parse(raw);
    const selected = await this.db.query('SELECT * FROM media_assets WHERE id=$1', [id]);
    const asset = selected.rows[0];
    if (!asset) return;
    if (asset.status === 'deleted') {
      await this.cleanup({ assetId: id });
      return;
    }
    if (asset.status === 'ready' || asset.status === 'rejected') {
      await this.store.delete(`${id}/original`);
      return;
    }
    const original = await this.store.get(`${id}/original`);
    if (createHash('sha256').update(original).digest('hex') !== asset.original_hash)
      throw new Error('Media integrity check failed.');
    let thumbnail: Buffer, hero: Buffer;
    try {
      const metadata = await sharp(original, { limitInputPixels: 20_000_000 }).metadata();
      if (
        !['jpeg', 'png', 'webp'].includes(metadata.format ?? '') ||
        (metadata.pages ?? 1) > 1 ||
        `image/${metadata.format}` !== asset.content_type
      )
        throw new Error('Unsupported image content.');
      thumbnail = await sharp(original, { limitInputPixels: 20_000_000 })
        .autoOrient()
        .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      hero = await sharp(original, { limitInputPixels: 20_000_000 })
        .autoOrient()
        .resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
    } catch {
      await this.db.query("UPDATE media_assets SET status='rejected' WHERE id=$1 AND status='processing'", [
        id,
      ]);
      await this.store.delete(`${id}/original`);
      return;
    }
    await this.store.put(`${id}/thumbnail.webp`, thumbnail, 'image/webp');
    await this.store.put(`${id}/hero.webp`, hero, 'image/webp');
    await this.db.query(
      "UPDATE media_assets SET status='ready',version=version+1 WHERE id=$1 AND status='processing'",
      [id],
    );
    const current = (await this.db.query('SELECT status FROM media_assets WHERE id=$1', [id])).rows[0];
    if (current?.status === 'deleted') {
      await this.cleanup({ assetId: id });
      return;
    }
    await this.store.delete(`${id}/original`);
  }
  async attach(actor: Principal, venueId: string, raw: unknown) {
    const input = z
      .object({ assetId: z.string().uuid(), expectedVersion: z.number().int().positive() })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await this.organizations.authorizeVenue(actor, venueId, 'venue.edit', tx);
      const asset = await tx.query(
        "SELECT id FROM media_assets WHERE id=$1 AND venue_id=$2 AND status='ready' FOR SHARE",
        [input.assetId, venueId],
      );
      if (!asset.rowCount)
        throw new ApiError('MEDIA_NOT_READY', 'Choose a processed image for this venue.', 409);
      const venue = await tx.query(
        'UPDATE venues SET hero_media_id=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING *',
        [input.assetId, venueId, input.expectedVersion],
      );
      if (!venue.rowCount) throw new ApiError('VERSION_CONFLICT', 'Venue changed.', 409);
      await revision(tx, actor, 'venue', venueId, venue.rows[0]!.version, venue.rows[0]);
      await audit(tx, actor.userId, 'media.attach', 'venue', venueId, 'Venue image selected', {
        assetId: input.assetId,
      });
      return { data: { venueId, version: venue.rows[0]!.version } };
    });
  }
  async publicImage(id: string, variant: 'hero' | 'thumbnail') {
    const available = await this.db.query(
      `SELECT m.id FROM media_assets m JOIN venues v ON v.id=m.venue_id JOIN destinations d ON d.id=v.destination_id
      WHERE m.id=$1 AND m.status='ready' AND (v.hero_media_id=m.id OR EXISTS(SELECT 1 FROM events e WHERE e.hero_media_id=m.id AND e.status='published')) AND v.status='published' AND d.published=true`,
      [id],
    );
    if (!available.rowCount) throw new ApiError('NOT_FOUND', 'Image not found.', 404);
    return this.store.get(`${id}/${variant}.webp`);
  }
  async remove(actor: Principal, id: string) {
    return this.db.transaction(async (tx) => {
      const asset = (await tx.query('SELECT * FROM media_assets WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!asset) throw new ApiError('NOT_FOUND', 'Asset not found.', 404);
      await this.authorizeAsset(actor, asset, tx);
      const used = await tx.query(
        'SELECT id::text FROM venues WHERE hero_media_id=$1 UNION ALL SELECT id::text FROM events WHERE hero_media_id=$1',
        [id],
      );
      if (used.rowCount) throw new ApiError('MEDIA_IN_USE', 'Replace the image before deleting it.', 409);
      await tx.query("UPDATE media_assets SET status='deleted',version=version+1 WHERE id=$1", [id]);
      await enqueue(tx, 'media.cleanup', id, { assetId: id });
      await audit(tx, actor.userId, 'media.delete', 'media', id, 'Unreferenced image removed');
      return { data: { deleted: true } };
    });
  }
  async cleanup(raw: unknown) {
    const { assetId: id } = z.object({ assetId: z.string().uuid() }).parse(raw);
    const row = (await this.db.query('SELECT status FROM media_assets WHERE id=$1', [id])).rows[0];
    if (row?.status !== 'deleted') return;
    for (const key of ['original', 'thumbnail.webp', 'hero.webp']) await this.store.delete(`${id}/${key}`);
  }
  async expireUploads() {
    await this.db.transaction(async (tx) => {
      const expired = await tx.query(
        "UPDATE media_assets SET status='deleted' WHERE status='pending' AND expires_at<now() RETURNING id",
      );
      for (const asset of expired.rows) await enqueue(tx, 'media.cleanup', asset.id, { assetId: asset.id });
    });
  }
  async createForEvent(actor: Principal, eventId: string, raw: unknown) {
    const event = (await this.db.query('SELECT venue_id FROM events WHERE id=$1', [eventId])).rows[0];
    if (!event) throw new ApiError('NOT_FOUND', 'Event not found.', 404);
    return this.create(actor, event.venue_id, raw, eventId);
  }
  async inspect(actor: Principal, id: string) {
    const asset = (
      await this.db.query('SELECT id,venue_id,event_id,status,alt_text FROM media_assets WHERE id=$1', [id])
    ).rows[0];
    if (!asset) throw new ApiError('NOT_FOUND', 'Image not found.', 404);
    await this.authorizeAsset(actor, asset as { venue_id: string; event_id?: string | null });
    return { data: asset };
  }
  async preview(actor: Principal, id: string, variant: 'hero' | 'thumbnail') {
    const asset = await this.inspect(actor, id);
    if (asset.data.status !== 'ready')
      throw new ApiError('MEDIA_NOT_READY', 'Image is not processed yet.', 409);
    return this.store.get(`${id}/${variant}.webp`);
  }
  async attachToEvent(actor: Principal, eventId: string, raw: unknown) {
    const input = z
      .object({ assetId: z.string().uuid(), expectedVersion: z.number().int().positive() })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const event = (await tx.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [eventId])).rows[0];
      if (!event) throw new ApiError('NOT_FOUND', 'Event not found.', 404);
      await this.authorizeAsset(actor, { venue_id: event.venue_id, event_id: eventId }, tx);
      const asset = await tx.query(
        "SELECT id FROM media_assets WHERE id=$1 AND venue_id=$2 AND (event_id IS NULL OR event_id=$3) AND status='ready' FOR SHARE",
        [input.assetId, event.venue_id, eventId],
      );
      if (!asset.rowCount)
        throw new ApiError('MEDIA_NOT_READY', 'Choose a processed image for this event.', 409);
      const updated = await tx.query(
        'UPDATE events SET hero_media_id=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING *',
        [input.assetId, eventId, input.expectedVersion],
      );
      if (!updated.rowCount) throw new ApiError('VERSION_CONFLICT', 'Event changed.', 409);
      await revision(tx, actor, 'event', eventId, updated.rows[0]!.version, updated.rows[0]);
      await audit(tx, actor.userId, 'media.attach', 'event', eventId, 'Event image selected', {
        assetId: input.assetId,
      });
      return { data: { eventId, version: updated.rows[0]!.version } };
    });
  }
}
