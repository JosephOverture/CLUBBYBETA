import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { IdentityRequest } from '../identity/identity.service';
import { OrganizationsService, audit } from './organizations.service';
import { EventsService } from '../events/events.service';
import { ApiError } from '../platform/http';
const uuid = (value: string) => z.string().uuid().parse(value);
const querySchema = z.object({ before: z.string().uuid().optional() }).strict();
const page = (rows: Record<string, any>[]) => ({
  data: rows.slice(0, 50),
  meta: { nextCursor: rows.length > 50 ? rows[49]!.id : null },
});
@Controller('v1')
export class WorkspaceController {
  constructor(
    @Inject(OrganizationsService) readonly organizations: OrganizationsService,
    @Inject(EventsService) readonly events: EventsService,
  ) {}
  @Get('organizations/:id/venues') async venues(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query() raw: unknown,
  ) {
    const { before } = z
      .object({ before: z.string().min(1).max(100).optional() })
      .strict()
      .parse(raw);
    return this.organizations.db.transaction(async (tx) => {
      const scope = await this.organizations.scope(req.principal!, uuid(id), 'venue.read', tx);
      return page(
        (
          await tx.query(
            'SELECT v.id,v.name,v.status,v.version,v.destination_id,d.timezone,d.currency,v.commercial_mode FROM venues v JOIN destinations d ON d.id=v.destination_id WHERE v.organization_id=$1 AND ($2::text[] IS NULL OR v.id=ANY($2)) AND ($3::text IS NULL OR v.id<$3) ORDER BY v.id DESC LIMIT 51',
            [id, scope, before ?? null],
          )
        ).rows,
      );
    });
  }
  @Get('organizations/:id/events') async eventList(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query() raw: unknown,
  ) {
    const { before } = querySchema.parse(raw);
    return this.organizations.db.transaction(async (tx) => {
      const scope = await this.organizations.scope(req.principal!, uuid(id), 'event.edit', tx);
      return page(
        (
          await tx.query(
            'SELECT e.id,e.title,e.venue_id,v.name AS venue_name,e.organization_id,e.status,e.version FROM events e JOIN venues v ON v.id=e.venue_id WHERE (e.organization_id=$1 OR v.organization_id=$1) AND ($2::text[] IS NULL OR e.venue_id=ANY($2)) AND ($3::uuid IS NULL OR e.id<$3) ORDER BY e.id DESC LIMIT 51',
            [id, scope, before ?? null],
          )
        ).rows,
      );
    });
  }
  @Get('organizations/:id/proposals') async proposals(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query() raw: unknown,
  ) {
    const { before } = querySchema.parse(raw);
    return this.organizations.db.transaction(async (tx) => {
      const scope = await this.organizations.scope(req.principal!, uuid(id), 'event.edit', tx);
      return page(
        (
          await tx.query(
            'SELECT p.id,p.venue_id,v.name AS venue_name,p.payload,p.status,p.version,p.event_id FROM event_proposals p JOIN venues v ON v.id=p.venue_id WHERE p.organization_id=$1 AND ($2::text[] IS NULL OR p.venue_id=ANY($2)) AND ($3::uuid IS NULL OR p.id<$3) ORDER BY p.id DESC LIMIT 51',
            [id, scope, before ?? null],
          )
        ).rows,
      );
    });
  }
  @Get('organizations/:id/invitations') async invitations(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query() raw: unknown,
  ) {
    const { before } = querySchema.parse(raw);
    return this.organizations.db.transaction(async (tx) => {
      await this.organizations.authorize(req.principal!, uuid(id), 'members.manage', undefined, false, tx);
      return page(
        (
          await tx.query(
            'SELECT id,email,role,venue_ids,expires_at,accepted_at,revoked_at FROM staff_invitations WHERE organization_id=$1 AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT 51',
            [id, before ?? null],
          )
        ).rows,
      );
    });
  }
  @Get('organizations/:id/venue-claims') async claims(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query() raw: unknown,
  ) {
    const { before } = querySchema.parse(raw);
    await this.organizations.authorize(req.principal!, uuid(id), 'members.manage');
    return page(
      (
        await this.organizations.db.query(
          'SELECT c.id,c.venue_id,v.name AS venue_name,c.status,c.created_at,c.reviewed_at FROM venue_claims c JOIN venues v ON v.id=c.venue_id WHERE c.organization_id=$1 AND ($2::uuid IS NULL OR c.id<$2) ORDER BY c.id DESC LIMIT 51',
          [id, before ?? null],
        )
      ).rows,
    );
  }
  @Get('organizations/:id/promotions') async promotions(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query() raw: unknown,
  ) {
    const { before } = querySchema.parse(raw);
    return this.organizations.db.transaction(async (tx) => {
      await this.organizations.authorize(req.principal!, uuid(id), 'members.manage', undefined, false, tx);
      return page(
        (
          await tx.query(
            "SELECT p.*,(SELECT count(*)::int FROM promotion_uses u WHERE u.promotion_id=p.id AND u.status IN ('reserved','used')) AS committed_uses FROM promotion_codes p WHERE organization_id=$1 AND ($2::uuid IS NULL OR p.id<$2) ORDER BY p.id DESC LIMIT 51",
            [id, before ?? null],
          )
        ).rows,
      );
    });
  }
  @Post('organizations/:id/promotions/:promotionId/status') async promotionStatus(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Param('promotionId') promotionId: string,
    @Body() raw: unknown,
  ) {
    const input = z
      .object({
        active: z.boolean(),
        expectedVersion: z.number().int().positive(),
        reason: z.string().min(10).max(1000),
      })
      .strict()
      .parse(raw);
    return this.organizations.db.transaction(async (tx) => {
      await this.organizations.authorize(req.principal!, uuid(id), 'members.manage', undefined, false, tx);
      const updated = await tx.query(
        'UPDATE promotion_codes SET active=$1,version=version+1 WHERE id=$2 AND organization_id=$3 AND version=$4 RETURNING id,active,version',
        [input.active, uuid(promotionId), id, input.expectedVersion],
      );
      if (!updated.rowCount)
        throw new ApiError('VERSION_CONFLICT', 'Promotion changed or does not belong to this seller.', 409);
      await audit(tx, req.principal!.userId, 'promotion.status', 'promotion', promotionId, input.reason, {
        active: input.active,
      });
      return { data: updated.rows[0] };
    });
  }
  @Get('seller/occurrences/:id/inventory') async inventory(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
  ) {
    return this.organizations.db.transaction(async (tx) => {
      const occurrence = (await tx.query('SELECT * FROM occurrences WHERE id=$1', [uuid(id)])).rows[0];
      if (!occurrence) throw new ApiError('NOT_FOUND', 'Occurrence not found.', 404);
      const event = await this.events.authorizeEvent(req.principal!, occurrence.event_id, 'event.edit', tx);
      return {
        data: {
          occurrence,
          organizationId: event.organization_id,
          venueId: event.venue_id,
          hostOrganizationId: (
            await tx.query('SELECT organization_id FROM venues WHERE id=$1', [event.venue_id])
          ).rows[0]!.organization_id,
          products: (
            await tx.query(
              "SELECT p.*,(SELECT coalesce(sum(r.quantity),0)::int FROM inventory_reservations r WHERE r.product_id=p.id AND r.status<>'released') AS committed FROM ticket_products p WHERE p.occurrence_id=$1 AND p.kind='ticket' ORDER BY p.id",
              [id],
            )
          ).rows,
          blocks: (
            await tx.query(
              'SELECT id,quantity,reason,released_at FROM inventory_blocks WHERE occurrence_id=$1 ORDER BY created_at DESC LIMIT 200',
              [id],
            )
          ).rows,
          layout:
            (
              await tx.query(
                'SELECT p.version,p.layout_id,l.content FROM occurrence_layouts p JOIN venue_layouts l ON l.id=p.layout_id WHERE p.occurrence_id=$1',
                [id],
              )
            ).rows[0] ?? null,
          tableOffers: (
            await tx.query('SELECT * FROM table_offers WHERE occurrence_id=$1 ORDER BY slot_starts_at,id', [
              id,
            ])
          ).rows,
        },
      };
    });
  }
  @Get('seller/venues/:id/media') async media(@Req() req: IdentityRequest, @Param('id') id: string) {
    await this.organizations.authorizeVenue(req.principal!, id, 'venue.read');
    return {
      data: (
        await this.organizations.db.query(
          'SELECT id,event_id,alt_text,status,created_at FROM media_assets WHERE venue_id=$1 ORDER BY created_at DESC LIMIT 200',
          [id],
        )
      ).rows,
    };
  }
  @Get('seller/events/:id/media') async eventMedia(@Req() req: IdentityRequest, @Param('id') id: string) {
    await this.events.authorizeEvent(req.principal!, uuid(id), 'event.edit');
    return {
      data: (
        await this.organizations.db.query(
          'SELECT id,event_id,alt_text,status,created_at FROM media_assets WHERE event_id=$1 ORDER BY created_at DESC LIMIT 200',
          [id],
        )
      ).rows,
    };
  }
}
