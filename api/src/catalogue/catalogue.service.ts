import { z } from 'zod';
import type { PoolClient, QueryResultRow } from 'pg';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import type { Principal } from '../identity/identity.service';
import {
  createVenueInput,
  venueInput,
  timezoneSchema,
  versionedReason,
  externalUrlSchema,
} from './catalogue.schemas';
import { idSchema } from '@clubby/contracts';
import { randomUUID } from 'node:crypto';
import { featureSettings } from '../administration/administration.service';

export async function revision(
  tx: PoolClient,
  actor: Principal,
  type: string,
  id: string,
  version: number,
  snapshot: unknown,
) {
  await tx.query(
    'INSERT INTO catalogue_revisions(resource_type,resource_id,version,actor_id,snapshot) VALUES($1,$2,$3,$4,$5)',
    [type, id, version, actor.userId, JSON.stringify(snapshot)],
  );
}
export class CatalogueService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
  ) {}
  async destination(actor: Principal, raw: unknown) {
    await this.organizations.platform(actor);
    const input = z
      .object({
        id: idSchema,
        name: z.string().trim().min(1).max(100),
        countryCode: z.string().regex(/^[A-Z]{2}$/),
        timezone: timezoneSchema,
        currency: z.enum(['EUR', 'GBP', 'CZK', 'HUF', 'RSD', 'PLN']),
        published: z.boolean(),
        aliases: z.array(idSchema).max(20).default([]),
        reason: z.string().min(5).max(1000),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const aliases = await tx.query('SELECT id FROM destinations WHERE id=ANY($1::text[])', [input.aliases]);
      if (aliases.rowCount || input.aliases.includes(input.id))
        throw new ApiError('CONFLICT', 'Alias overlaps a canonical destination.', 409);
      if ((await tx.query('SELECT alias FROM destination_aliases WHERE alias=$1', [input.id])).rowCount)
        throw new ApiError('CONFLICT', 'Destination ID is already an alias.', 409);
      const inserted = await tx.query(
        'INSERT INTO destinations(id,name,country_code,timezone,currency,published) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',
        [input.id, input.name, input.countryCode, input.timezone, input.currency, input.published],
      );
      if (!inserted.rowCount) throw new ApiError('CONFLICT', 'Destination already exists.', 409);
      for (const alias of input.aliases)
        await tx.query('INSERT INTO destination_aliases(alias,destination_id) VALUES($1,$2)', [
          alias,
          input.id,
        ]);
      await audit(tx, actor.userId, 'destination.create', 'destination', input.id, input.reason);
      return { data: { id: input.id, version: 1 } };
    });
  }
  async destinationVisibility(actor: Principal, id: string, raw: unknown) {
    await this.organizations.platform(actor);
    const input = versionedReason.extend({ published: z.boolean() }).strict().parse(raw);
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        'UPDATE destinations SET published=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING id,version,published',
        [input.published, id, input.expectedVersion],
      );
      if (!result.rowCount)
        throw new ApiError('VERSION_CONFLICT', 'Destination changed or does not exist.', 409);
      await audit(tx, actor.userId, 'destination.visibility', 'destination', id, input.reason, {
        published: input.published,
      });
      return { data: result.rows[0] };
    });
  }
  async createVenue(actor: Principal, raw: unknown) {
    const input = createVenueInput.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.organizations.authorize(actor, input.organizationId, 'venue.edit', undefined, false, tx);
      const inserted = await tx.query(
        `INSERT INTO venues(id,destination_id,organization_id,name,description,latitude,longitude,tags,minimum_age,address,contact_url,schedule)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING *`,
        [
          input.id,
          input.destinationId,
          input.organizationId,
          input.name,
          input.description,
          input.latitude,
          input.longitude,
          input.tags,
          input.minimumAge,
          input.address,
          input.contactUrl,
          JSON.stringify(input.schedule),
        ],
      );
      if (!inserted.rows[0]) throw new ApiError('CONFLICT', 'Venue ID already exists.', 409);
      await revision(tx, actor, 'venue', input.id, 1, inserted.rows[0]);
      await audit(tx, actor.userId, 'venue.create', 'venue', input.id, 'Draft venue created');
      return { data: inserted.rows[0] };
    });
  }
  async editVenue(actor: Principal, id: string, raw: unknown) {
    const input = venueInput.extend({ expectedVersion: z.number().int().positive() }).strict().parse(raw);
    return this.db.transaction(async (tx) => {
      await this.organizations.authorizeVenue(actor, id, 'venue.edit', tx);
      const result = await tx.query(
        `UPDATE venues SET name=$1,description=$2,latitude=$3,longitude=$4,tags=$5,minimum_age=$6,address=$7,contact_url=$8,schedule=$9,version=version+1,updated_at=now()
        WHERE id=$10 AND version=$11 RETURNING *`,
        [
          input.name,
          input.description,
          input.latitude,
          input.longitude,
          input.tags,
          input.minimumAge,
          input.address,
          input.contactUrl,
          JSON.stringify(input.schedule),
          id,
          input.expectedVersion,
        ],
      );
      if (!result.rows[0])
        throw new ApiError('VERSION_CONFLICT', 'Venue was changed by another editor.', 409);
      await revision(tx, actor, 'venue', id, result.rows[0].version, result.rows[0]);
      await audit(tx, actor.userId, 'venue.edit', 'venue', id, 'Venue details updated');
      return { data: result.rows[0] };
    });
  }
  async publishVenue(actor: Principal, id: string, raw: unknown, platform = false) {
    const input = versionedReason
      .extend({ status: z.enum(['published', 'hidden']) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      if (platform) {
        await this.organizations.platformAny(actor, ['admin'], tx);
        if (
          input.status === 'published' &&
          !(
            await tx.query(
              "SELECT 1 FROM venues v JOIN organizations o ON o.id=v.organization_id WHERE v.id=$1 AND o.status='approved'",
              [id],
            )
          ).rowCount
        )
          throw new ApiError('NOT_ELIGIBLE', 'Approve the seller before publishing this venue.', 409);
      } else await this.organizations.authorizeVenue(actor, id, 'event.publish', tx);
      const result = await tx.query(
        `UPDATE venues SET status=$1,version=version+1,updated_at=now() WHERE id=$2 AND version=$3 RETURNING *`,
        [input.status, id, input.expectedVersion],
      );
      const venue = result.rows[0];
      if (!venue) throw new ApiError('VERSION_CONFLICT', 'Venue changed or does not exist.', 409);
      if (
        input.status === 'published' &&
        (venue.latitude === null || venue.longitude === null || !venue.description || !venue.address)
      )
        throw new ApiError(
          'INCOMPLETE_VENUE',
          'Add description, address and coordinates before publishing.',
          400,
        );
      await revision(tx, actor, 'venue', id, venue.version, venue);
      await audit(tx, actor.userId, 'venue.publication', 'venue', id, input.reason, { status: input.status });
      return { data: { id, version: venue.version, status: venue.status } };
    });
  }
  async commercialMode(actor: Principal, id: string, raw: unknown) {
    await this.organizations.platform(actor);
    const input = versionedReason
      .extend({ mode: z.enum(['native', 'external']), externalUrl: externalUrlSchema.nullable() })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        'UPDATE venues SET commercial_mode=$1,external_url=$2,version=version+1 WHERE id=$3 AND version=$4 RETURNING *',
        [input.mode, input.externalUrl, id, input.expectedVersion],
      );
      if (!result.rows[0]) throw new ApiError('VERSION_CONFLICT', 'Venue changed or does not exist.', 409);
      await revision(tx, actor, 'venue', id, result.rows[0].version, result.rows[0]);
      await audit(tx, actor.userId, 'venue.commercial-mode', 'venue', id, input.reason, { mode: input.mode });
      return { data: { id, version: result.rows[0].version, mode: input.mode } };
    });
  }
  async claim(actor: Principal, id: string, raw: unknown) {
    const input = z
      .object({ organizationId: z.string().uuid(), evidence: z.string().trim().min(20).max(5000) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await this.organizations.authorize(actor, input.organizationId, 'members.manage', undefined, false, tx);
      const claimId = randomUUID();
      const result = await tx.query(
        `INSERT INTO venue_claims(id,venue_id,organization_id,applicant_id,evidence) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(venue_id,organization_id) WHERE status='pending' DO UPDATE SET evidence=venue_claims.evidence RETURNING id,status`,
        [claimId, id, input.organizationId, actor.userId, input.evidence],
      );
      await audit(tx, actor.userId, 'venue.claim', 'venue', id, 'Venue claim submitted');
      return { data: result.rows[0] };
    });
  }
  async reviewClaim(actor: Principal, id: string, raw: unknown) {
    await this.organizations.platform(actor);
    const input = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        expectedVenueVersion: z.number().int().positive(),
        reason: z.string().min(5).max(1000),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const selected = await tx.query('SELECT * FROM venue_claims WHERE id=$1 FOR UPDATE', [id]);
      const claim = selected.rows[0];
      if (!claim) throw new ApiError('NOT_FOUND', 'Claim not found.', 404);
      if (claim.status === input.decision) return { data: { id, status: claim.status } };
      if (claim.status !== 'pending') throw new ApiError('CONFLICT', 'Claim was already reviewed.', 409);
      if (input.decision === 'approved') {
        const org = await tx.query(
          "SELECT id FROM organizations WHERE id=$1 AND status='approved' FOR SHARE",
          [claim.organization_id],
        );
        if (!org.rowCount) throw new ApiError('NOT_ELIGIBLE', 'Organization is not approved.', 409);
        const updated = await tx.query(
          'UPDATE venues SET organization_id=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING *',
          [claim.organization_id, claim.venue_id, input.expectedVenueVersion],
        );
        if (!updated.rows[0])
          throw new ApiError('VERSION_CONFLICT', 'Venue ownership or version changed.', 409);
        await revision(tx, actor, 'venue', claim.venue_id, updated.rows[0].version, updated.rows[0]);
      }
      await tx.query('UPDATE venue_claims SET status=$1,reviewed_at=now() WHERE id=$2', [input.decision, id]);
      await audit(tx, actor.userId, 'venue.claim-review', 'claim', id, input.reason, {
        decision: input.decision,
      });
      return { data: { id, status: input.decision } };
    });
  }
  async settings(actor: Principal, raw: unknown) {
    await this.organizations.platform(actor);
    const input = versionedReason
      .extend({
        banner: z.string().max(500),
        newSalesPaused: z.boolean(),
        features: featureSettings.optional(),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        'UPDATE public_settings SET banner=$1,new_sales_paused=$2,features=coalesce($4::jsonb,features),version=version+1 WHERE singleton=true AND version=$3 RETURNING banner,new_sales_paused,features,version',
        [
          input.banner,
          input.newSalesPaused,
          input.expectedVersion,
          input.features ? JSON.stringify(input.features) : null,
        ],
      );
      if (!result.rowCount) throw new ApiError('VERSION_CONFLICT', 'Settings changed.', 409);
      await audit(tx, actor.userId, 'settings.update', 'settings', 'public', input.reason);
      return { data: result.rows[0] };
    });
  }
}
