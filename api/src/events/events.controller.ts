import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { EventsService } from './events.service';
import { Public } from '../identity/session.guard';
import type { IdentityRequest } from '../identity/identity.service';
import { ApiError } from '../platform/http';

const publicEvents = `SELECT e.id,e.venue_id AS "venueId",e.title,e.description,e.lineup,e.tags,e.version,
  CASE WHEN v.commercial_mode='external' OR e.external_url IS NOT NULL THEN COALESCE(e.external_url,v.external_url) ELSE NULL END AS "externalUrl",
  CASE WHEN e.external_url IS NOT NULL THEN 'external' ELSE v.commercial_mode END AS "commercialMode",COALESCE(e.hero_media_id,v.hero_media_id) AS "heroMediaId",o.id AS "occurrenceId",o.starts_at AS "startsAt",o.ends_at AS "endsAt",o.timezone,o.currency,o.capacity
  FROM events e JOIN venues v ON v.id=e.venue_id JOIN destinations d ON d.id=v.destination_id JOIN occurrences o ON o.event_id=e.id
  WHERE e.status='published' AND v.status='published' AND d.published=true AND o.status='published' AND o.ends_at>now()`;
@Controller('v1')
export class EventsController {
  constructor(@Inject(EventsService) private readonly events: EventsService) {}
  @Public() @Get('venues/:id/events') async forVenue(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
  ) {
    let after: { venue: string; starts: string; id: string } | undefined;
    if (cursor) {
      try {
        after = z
          .object({ venue: z.string(), starts: z.iso.datetime(), id: z.string().uuid() })
          .parse(JSON.parse(Buffer.from(z.string().max(500).parse(cursor), 'base64url').toString()));
      } catch {
        throw new ApiError('INVALID_CURSOR', 'Event cursor is invalid.', 400);
      }
      if (after.venue !== id)
        throw new ApiError('INVALID_CURSOR', 'Event cursor belongs to another venue.', 400);
    }
    const rows = (
      await this.events.db.query(
        `SELECT q.*,to_char(q."startsAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "_cursorStarts" FROM (${publicEvents} AND v.id=$1 AND ($2::timestamptz IS NULL OR (o.starts_at,o.id)>($2::timestamptz,$3::uuid))) q ORDER BY q."startsAt",q."occurrenceId" LIMIT 101`,
        [id, after?.starts ?? null, after?.id ?? null],
      )
    ).rows;
    const last = rows[99];
    return {
      data: rows.slice(0, 100).map(({ _cursorStarts, ...row }) => row),
      meta: {
        nextCursor:
          rows.length > 100
            ? Buffer.from(
                JSON.stringify({ venue: id, starts: last!._cursorStarts, id: last!.occurrenceId }),
              ).toString('base64url')
            : null,
      },
    };
  }
  @Public() @Get('events/:id') async detail(@Param('id') id: string) {
    const rows = await this.events.db.query(`${publicEvents} AND e.id=$1 ORDER BY o.starts_at,o.id`, [
      z.string().uuid().parse(id),
    ]);
    if (!rows.rowCount) throw new ApiError('NOT_FOUND', 'Published event not found.', 404);
    return { data: rows.rows };
  }
  @Post('seller/events') create(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.events.create(req.principal!, body);
  }
  @Post('seller/events/:id') edit(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.events.edit(req.principal!, z.string().uuid().parse(id), body);
  }
  @Post('seller/occurrences/:id/change') change(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.events.changeOccurrence(req.principal!, z.string().uuid().parse(id), body);
  }
  @Post('seller/events/:id/publication') publish(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.events.publish(req.principal!, z.string().uuid().parse(id), body);
  }
  @Get('seller/events/:id') async preview(@Req() req: IdentityRequest, @Param('id') id: string) {
    z.string().uuid().parse(id);
    await this.events.authorizeEvent(req.principal!, id, 'event.edit');
    return {
      data: {
        event: (
          await this.events.db.query(
            'SELECT e.*,v.organization_id AS host_organization_id FROM events e JOIN venues v ON v.id=e.venue_id WHERE e.id=$1',
            [id],
          )
        ).rows[0],
        occurrences: (
          await this.events.db.query('SELECT * FROM occurrences WHERE event_id=$1 ORDER BY starts_at', [id])
        ).rows,
      },
    };
  }
  @Post('seller/proposals') propose(@Req() req: IdentityRequest, @Body() body: unknown) {
    return this.events.propose(req.principal!, body);
  }
  @Post('seller/proposals/:id/review') review(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.events.reviewProposal(req.principal!, z.string().uuid().parse(id), body);
  }
  @Post('seller/proposals/:id/resubmit') resubmit(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.events.resubmit(req.principal!, z.string().uuid().parse(id), body);
  }
  @Get('seller/venues/:id/proposals') async queue(
    @Req() req: IdentityRequest,
    @Param('id') id: string,
    @Query() raw: unknown,
  ) {
    const { before } = z.object({ before: z.string().uuid().optional() }).strict().parse(raw);
    await this.events.organizations.authorizeVenue(req.principal!, id, 'event.publish');
    const result = await this.events.db.query(
      'SELECT id,venue_id,payload,status,version,event_id FROM event_proposals WHERE venue_id=$1 AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT 51',
      [id, before ?? null],
    );
    return {
      data: result.rows.slice(0, 50),
      meta: { nextCursor: result.rows.length > 50 ? result.rows[49]!.id : null },
    };
  }
  @Get('seller/proposals/:id/history') async history(@Req() req: IdentityRequest, @Param('id') id: string) {
    const proposal = (
      await this.events.db.query('SELECT * FROM event_proposals WHERE id=$1', [z.string().uuid().parse(id)])
    ).rows[0];
    if (!proposal) throw new ApiError('NOT_FOUND', 'Proposal not found.', 404);
    try {
      await this.events.organizations.authorize(req.principal!, proposal.organization_id, 'event.edit');
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'FORBIDDEN') throw error;
      await this.events.organizations.authorizeVenue(req.principal!, proposal.venue_id, 'event.publish');
    }
    return {
      data: (
        await this.events.db.query('SELECT * FROM proposal_reviews WHERE proposal_id=$1 ORDER BY version', [
          id,
        ])
      ).rows,
    };
  }
}
