import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { idSchema } from '@clubby/contracts';
import type { IdentityRequest } from '../identity/identity.service';
import { Public } from '../identity/session.guard';
import { CatalogueService } from './catalogue.service';
import { ApiError } from '../platform/http';
import { audit } from '../organizations/organizations.service';

@Controller('v1')
export class ManagementController {
  constructor(@Inject(CatalogueService) private readonly catalogue: CatalogueService) {}
  @Public() @Get('destinations') async destinations() {
    return {
      data: (
        await this.catalogue.db.query(
          'SELECT id,name,country_code AS "countryCode",timezone,currency FROM destinations WHERE published=true ORDER BY name',
        )
      ).rows,
    };
  }
  @Post('admin/destinations') createDestination(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.catalogue.destination(req.principal!, body);
  }
  @Post('admin/destinations/:id/visibility') visibility(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalogue.destinationVisibility(req.principal!, idSchema.parse(id), body);
  }
  @Post('seller/venues') create(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.catalogue.createVenue(req.principal!, body);
  }
  @Post('seller/venues/:id') edit(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalogue.editVenue(req.principal!, idSchema.parse(id), body);
  }
  @Post('seller/venues/:id/publication') publish(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalogue.publishVenue(req.principal!, idSchema.parse(id), body);
  }
  @Get('seller/venues/:id') async preview(@Req() req: IdentityRequest, @Param('id') id: string) {
    await this.catalogue.organizations.authorizeVenue(req.principal!, id, 'venue.read');
    return { data: (await this.catalogue.db.query('SELECT * FROM venues WHERE id=$1', [id])).rows[0] };
  }
  @Post('admin/venues/:id/commercial-mode') mode(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalogue.commercialMode(req.principal!, idSchema.parse(id), body);
  }
  @Post('admin/venues/:id/publication') adminPublish(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalogue.publishVenue(req.principal!, idSchema.parse(id), body, true);
  }
  @Post('venues/:id/claims') claim(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalogue.claim(req.principal!, idSchema.parse(id), body);
  }
  @Get('admin/venue-claims') async claims(@Req() req: IdentityRequest, @Query() raw: unknown) {
    await this.catalogue.organizations.platform(req.principal!);
    const { before } = z.object({ before: z.string().uuid().optional() }).strict().parse(raw);
    const result = await this.catalogue.db.query(
      "SELECT c.id,c.venue_id,c.organization_id,c.evidence,c.status,v.name AS venue_name,v.version AS venue_version,o.name AS organization_name FROM venue_claims c JOIN venues v ON v.id=c.venue_id JOIN organizations o ON o.id=c.organization_id WHERE c.status='pending' AND ($1::uuid IS NULL OR c.id<$1) ORDER BY c.id DESC LIMIT 51",
      [before ?? null],
    );
    return {
      data: result.rows.slice(0, 50),
      meta: { nextCursor: result.rows.length > 50 ? result.rows[49]!.id : null },
    };
  }
  @Post('admin/venue-claims/:id/review') reviewClaim(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalogue.reviewClaim(req.principal!, z.string().uuid().parse(id), body);
  }
  @Post('admin/settings') settings(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.catalogue.settings(req.principal!, body);
  }
  @Post('me/saved-venues/:id') async save(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    this.catalogue.organizations.verified(req.principal!);
    const { saved } = z.object({ saved: z.boolean() }).strict().parse(body);
    if (saved) {
      const result = await this.catalogue.db.query(
        `INSERT INTO saved_venues(user_id,venue_id) SELECT $1,v.id FROM venues v JOIN destinations d ON d.id=v.destination_id WHERE v.id=$2 AND v.status='published' AND d.published=true ON CONFLICT DO NOTHING RETURNING venue_id`,
        [req.principal!.userId, id],
      );
      if (
        !result.rowCount &&
        !(
          await this.catalogue.db.query(
            'SELECT venue_id FROM saved_venues WHERE user_id=$1 AND venue_id=$2',
            [req.principal!.userId, id],
          )
        ).rowCount
      )
        throw new ApiError('NOT_FOUND', 'Published venue not found.', 404);
    } else
      await this.catalogue.db.query('DELETE FROM saved_venues WHERE user_id=$1 AND venue_id=$2', [
        req.principal!.userId,
        id,
      ]);
    return { data: { saved } };
  }
  @Get('me/saved-venues/:id') async savedStatus(@Req() req: IdentityRequest, @Param('id') id: string) {
    const result = await this.catalogue.db.query(
      'SELECT 1 FROM saved_venues WHERE user_id=$1 AND venue_id=$2',
      [req.principal!.userId, idSchema.parse(id)],
    );
    return { data: { saved: Boolean(result.rowCount) } };
  }
  @Get('me/saved-venues') async saved(@Req() req: IdentityRequest, @Query('after') rawAfter?: string) {
    const after = idSchema.optional().parse(rawAfter);
    const rows = (
      await this.catalogue.db.query(
        `SELECT v.id,v.name FROM saved_venues s JOIN venues v ON v.id=s.venue_id JOIN destinations d ON d.id=v.destination_id WHERE s.user_id=$1 AND v.status='published' AND d.published=true AND ($2::text IS NULL OR v.id>$2) ORDER BY v.id LIMIT 51`,
        [req.principal!.userId, after ?? null],
      )
    ).rows;
    return {
      data: rows.slice(0, 50),
      meta: { nextCursor: rows.length > 50 ? rows[49]!.id : null },
    };
  }
  @Post('admin/editorial') async editorial(@Req() req: IdentityRequest, @Body() body: unknown) {
    await this.catalogue.organizations.platform(req.principal!);
    const input = z
      .object({
        venueId: idSchema,
        rank: z.number().int().min(0),
        startsAt: z.iso.datetime({ offset: true }),
        endsAt: z.iso.datetime({ offset: true }),
        reason: z.string().min(5).max(1000),
        expectedVersion: z.number().int().nonnegative().default(0),
      })
      .strict()
      .parse(body);
    if (Date.parse(input.endsAt) <= Date.parse(input.startsAt))
      throw new ApiError('INVALID_TIME_RANGE', 'End must follow start.', 400);
    return this.catalogue.db.transaction(async (tx) => {
      const existing = await tx.query('SELECT id FROM venues WHERE id=$1 FOR UPDATE', [input.venueId]);
      if (!existing.rowCount) throw new ApiError('NOT_FOUND', 'Venue not found.', 404);
      const current = (
        await tx.query('SELECT version FROM editorial_placements WHERE venue_id=$1', [input.venueId])
      ).rows[0];
      if ((current?.version ?? 0) !== input.expectedVersion)
        throw new ApiError('VERSION_CONFLICT', 'Editorial placement changed. Reload before saving.', 409);
      await tx.query(
        `INSERT INTO editorial_placements(venue_id,rank,starts_at,ends_at) VALUES($1,$2,$3,$4) ON CONFLICT(venue_id) DO UPDATE SET rank=EXCLUDED.rank,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,active=true,version=editorial_placements.version+1`,
        [input.venueId, input.rank, input.startsAt, input.endsAt],
      );
      await audit(tx, req.principal!.userId, 'editorial.update', 'venue', input.venueId, input.reason);
      return { data: { updated: true } };
    });
  }
  @Get('admin/editorial') async editorialList(@Req() req: IdentityRequest, @Query() raw: unknown) {
    await this.catalogue.organizations.platform(req.principal!);
    const { before } = z.object({ before: idSchema.optional() }).strict().parse(raw);
    const result = await this.catalogue.db.query(
      'SELECT e.*,v.name,v.status FROM editorial_placements e JOIN venues v ON v.id=e.venue_id WHERE ($1::text IS NULL OR e.venue_id<$1) ORDER BY e.venue_id DESC LIMIT 51',
      [before ?? null],
    );
    return {
      data: result.rows.slice(0, 50),
      meta: { nextCursor: result.rows.length > 50 ? result.rows[49]!.venue_id : null },
    };
  }
  @Post('admin/editorial/:id/remove') async removeEditorial(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    await this.catalogue.organizations.platform(req.principal!);
    const input = z
      .object({ expectedVersion: z.number().int().positive(), reason: z.string().min(5).max(1000) })
      .strict()
      .parse(raw);
    return this.catalogue.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM venues WHERE id=$1 FOR UPDATE', [idSchema.parse(id)]);
      const removed = await tx.query(
        'UPDATE editorial_placements SET active=false,version=version+1 WHERE venue_id=$1 AND version=$2 RETURNING venue_id',
        [id, input.expectedVersion],
      );
      if (!removed.rowCount)
        throw new ApiError('VERSION_CONFLICT', 'Editorial placement changed or was removed.', 409);
      await audit(tx, req.principal!.userId, 'editorial.remove', 'venue', id, input.reason);
      return { data: { removed: true } };
    });
  }
  @Public() @Get('discover') async discover() {
    return {
      data: {
        editorial: (
          await this.catalogue.db.query(
            `SELECT v.id,v.name,v.hero_media_id AS "heroMediaId" FROM editorial_placements e JOIN venues v ON v.id=e.venue_id JOIN destinations d ON d.id=v.destination_id WHERE e.active AND e.starts_at<=now() AND e.ends_at>now() AND v.status='published' AND d.published=true ORDER BY e.rank,v.id LIMIT 30`,
          )
        ).rows,
      },
    };
  }
}
