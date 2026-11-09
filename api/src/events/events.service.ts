import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import type { Principal } from '../identity/identity.service';
import { eventInput, versionedReason, validZonedInstant } from '../catalogue/catalogue.schemas';
import { revision } from '../catalogue/catalogue.service';
import { enqueue } from '../platform/jobs';

export class EventsService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
  ) {}
  private async insert(
    tx: PoolClient,
    actor: Principal,
    venueId: string,
    organizationId: string,
    input: z.infer<typeof eventInput>,
    published = false,
  ) {
    const venue = await tx.query<{ timezone: string; currency: string; status: string; published: boolean }>(
      `SELECT d.timezone,d.currency,v.status,d.published FROM venues v JOIN destinations d ON d.id=v.destination_id WHERE v.id=$1 FOR SHARE OF v,d`,
      [venueId],
    );
    const location = venue.rows[0];
    if (!location) throw new ApiError('NOT_FOUND', 'Venue does not exist.', 404);
    if (published && (location.status !== 'published' || !location.published))
      throw new ApiError('NOT_PUBLISHED', 'Publish the venue and destination first.', 409);
    for (const occurrence of input.occurrences) {
      if (
        !validZonedInstant(occurrence.startsAt, location.timezone) ||
        !validZonedInstant(occurrence.endsAt, location.timezone)
      )
        throw new ApiError(
          'INVALID_LOCAL_TIME',
          'Use an explicit offset matching the venue timezone; skipped DST times are invalid.',
          400,
        );
      if (Date.parse(occurrence.endsAt) <= Date.parse(occurrence.startsAt))
        throw new ApiError('INVALID_TIME_RANGE', 'End must be after start, including overnight events.', 400);
    }
    const id = randomUUID();
    await tx.query(
      `INSERT INTO events(id,venue_id,organization_id,title,description,lineup,tags,external_url,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        venueId,
        organizationId,
        input.title,
        input.description,
        input.lineup,
        input.tags,
        input.externalUrl,
        published ? 'published' : 'draft',
      ],
    );
    const occurrences = [];
    for (const occurrence of input.occurrences) {
      const occurrenceId = randomUUID();
      occurrences.push(occurrenceId);
      await tx.query(
        'INSERT INTO occurrences(id,event_id,starts_at,ends_at,timezone,currency,capacity,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          occurrenceId,
          id,
          occurrence.startsAt,
          occurrence.endsAt,
          location.timezone,
          location.currency,
          occurrence.capacity,
          published ? 'published' : 'draft',
        ],
      );
    }
    await revision(tx, actor, 'event', id, 1, { ...input, venueId, organizationId });
    await audit(
      tx,
      actor.userId,
      'event.create',
      'event',
      id,
      published ? 'Approved proposal created an event' : 'Draft event created',
    );
    return { id, occurrenceIds: occurrences, version: 1 };
  }
  async create(actor: Principal, raw: unknown) {
    const input = eventInput
      .extend({ venueId: z.string().min(1).max(100) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const organizationId = await this.organizations.authorizeVenue(actor, input.venueId, 'event.edit', tx);
      return { data: await this.insert(tx, actor, input.venueId, organizationId, input) };
    });
  }
  async authorizeEvent(
    actor: Principal,
    id: string,
    permission: 'event.edit' | 'event.publish',
    tx?: PoolClient,
  ) {
    const result = tx
      ? await tx.query('SELECT venue_id,organization_id FROM events WHERE id=$1', [id])
      : await this.db.query('SELECT venue_id,organization_id FROM events WHERE id=$1', [id]);
    const event = result.rows[0];
    if (!event) throw new ApiError('NOT_FOUND', 'Event not found.', 404);
    if (permission === 'event.publish')
      await this.organizations.authorizeVenue(actor, event.venue_id, permission, tx);
    else {
      try {
        await this.organizations.authorize(
          actor,
          event.organization_id,
          permission,
          event.venue_id,
          false,
          tx,
        );
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'FORBIDDEN') throw error;
        await this.organizations.authorizeVenue(actor, event.venue_id, permission, tx);
      }
    }
    return event;
  }
  async publish(actor: Principal, id: string, raw: unknown) {
    const input = versionedReason
      .extend({ status: z.enum(['published', 'hidden']) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const event = await this.authorizeEvent(actor, id, 'event.publish', tx);
      if (input.status === 'published') {
        const parent = await tx.query(
          "SELECT v.id FROM venues v JOIN destinations d ON d.id=v.destination_id WHERE v.id=$1 AND v.status='published' AND d.published=true",
          [event.venue_id],
        );
        if (!parent.rowCount)
          throw new ApiError('NOT_PUBLISHED', 'Publish the venue and destination first.', 409);
      }
      const result = await tx.query(
        "UPDATE events SET status=$1,version=version+1,updated_at=now() WHERE id=$2 AND version=$3 AND status<>'cancelled' RETURNING *",
        [input.status, id, input.expectedVersion],
      );
      if (!result.rows[0])
        throw new ApiError('VERSION_CONFLICT', 'Event changed, was cancelled or does not exist.', 409);
      await tx.query(
        "UPDATE occurrences SET status=$1,version=version+1 WHERE event_id=$2 AND status<>'cancelled'",
        [input.status, id],
      );
      await revision(tx, actor, 'event', id, result.rows[0].version, result.rows[0]);
      await audit(tx, actor.userId, 'event.publication', 'event', id, input.reason, { status: input.status });
      return { data: { id, status: input.status, version: result.rows[0].version } };
    });
  }
  async propose(actor: Principal, raw: unknown) {
    const input = z
      .object({ venueId: z.string().min(1).max(100), organizationId: z.string().uuid(), event: eventInput })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await this.organizations.authorize(actor, input.organizationId, 'event.edit', undefined, false, tx);
      const venue = await tx.query("SELECT id FROM venues WHERE id=$1 AND status='published'", [
        input.venueId,
      ]);
      if (!venue.rowCount) throw new ApiError('NOT_FOUND', 'Published venue not found.', 404);
      const id = randomUUID();
      await tx.query(
        'INSERT INTO event_proposals(id,venue_id,organization_id,author_id,payload) VALUES($1,$2,$3,$4,$5)',
        [id, input.venueId, input.organizationId, actor.userId, JSON.stringify(input.event)],
      );
      await tx.query(
        "INSERT INTO proposal_reviews(proposal_id,actor_id,decision,comment,payload,version) VALUES($1,$2,'submitted','Proposal submitted',$3,1)",
        [id, actor.userId, JSON.stringify(input.event)],
      );
      await audit(tx, actor.userId, 'proposal.submit', 'proposal', id, 'Proposal submitted for venue review');
      return { data: { id, status: 'submitted', version: 1 } };
    });
  }
  async reviewProposal(actor: Principal, id: string, raw: unknown) {
    const input = versionedReason
      .extend({ decision: z.enum(['approved', 'rejected', 'changes-requested']) })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const selected = await tx.query('SELECT * FROM event_proposals WHERE id=$1 FOR UPDATE', [id]);
      const proposal = selected.rows[0];
      if (!proposal) throw new ApiError('NOT_FOUND', 'Proposal not found.', 404);
      await this.organizations.authorizeVenue(actor, proposal.venue_id, 'event.publish', tx);
      if (proposal.status === 'approved' && input.decision === 'approved')
        return { data: { id, eventId: proposal.event_id, status: 'approved', version: proposal.version } };
      if (proposal.version !== input.expectedVersion || proposal.status !== 'submitted')
        throw new ApiError('VERSION_CONFLICT', 'Proposal is not the submitted revision.', 409);
      let eventId: null | string = null;
      if (input.decision === 'approved') {
        const approved = await tx.query(
          "SELECT id FROM organizations WHERE id=$1 AND status='approved' FOR SHARE",
          [proposal.organization_id],
        );
        if (!approved.rowCount)
          throw new ApiError('NOT_ELIGIBLE', 'Proposing organization is no longer approved.', 409);
        eventId = (
          await this.insert(
            tx,
            actor,
            proposal.venue_id,
            proposal.organization_id,
            eventInput.parse(proposal.payload),
            true,
          )
        ).id;
      }
      await tx.query('UPDATE event_proposals SET status=$1,event_id=$2,version=version+1 WHERE id=$3', [
        input.decision,
        eventId,
        id,
      ]);
      await tx.query(
        'INSERT INTO proposal_reviews(proposal_id,actor_id,decision,comment,payload,version) VALUES($1,$2,$3,$4,$5,$6)',
        [
          id,
          actor.userId,
          input.decision,
          input.reason,
          JSON.stringify(proposal.payload),
          proposal.version + 1,
        ],
      );
      await audit(tx, actor.userId, 'proposal.review', 'proposal', id, input.reason, {
        decision: input.decision,
      });
      return { data: { id, eventId, status: input.decision, version: proposal.version + 1 } };
    });
  }
  async resubmit(actor: Principal, id: string, raw: unknown) {
    const input = z
      .object({ expectedVersion: z.number().int().positive(), event: eventInput })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const selected = await tx.query('SELECT * FROM event_proposals WHERE id=$1 FOR UPDATE', [id]);
      const proposal = selected.rows[0];
      if (!proposal) throw new ApiError('NOT_FOUND', 'Proposal not found.', 404);
      await this.organizations.authorize(actor, proposal.organization_id, 'event.edit', undefined, false, tx);
      if (
        !['changes-requested', 'rejected'].includes(proposal.status) ||
        proposal.version !== input.expectedVersion
      )
        throw new ApiError('VERSION_CONFLICT', 'Proposal cannot be resubmitted in this state.', 409);
      await tx.query(
        "UPDATE event_proposals SET payload=$1,status='submitted',version=version+1 WHERE id=$2",
        [JSON.stringify(input.event), id],
      );
      await tx.query(
        "INSERT INTO proposal_reviews(proposal_id,actor_id,decision,comment,payload,version) VALUES($1,$2,'submitted','Revised proposal submitted',$3,$4)",
        [id, actor.userId, JSON.stringify(input.event), proposal.version + 1],
      );
      return { data: { id, status: 'submitted', version: proposal.version + 1 } };
    });
  }
  async edit(actor: Principal, id: string, raw: unknown) {
    const input = eventInput
      .omit({ occurrences: true })
      .extend({ expectedVersion: z.number().int().positive() })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await this.authorizeEvent(actor, id, 'event.edit', tx);
      const result = await tx.query(
        "UPDATE events SET title=$1,description=$2,lineup=$3,tags=$4,external_url=$5,version=version+1,updated_at=now() WHERE id=$6 AND version=$7 AND status<>'cancelled' RETURNING *",
        [
          input.title,
          input.description,
          input.lineup,
          input.tags,
          input.externalUrl,
          id,
          input.expectedVersion,
        ],
      );
      if (!result.rows[0]) throw new ApiError('VERSION_CONFLICT', 'Event changed or was cancelled.', 409);
      await revision(tx, actor, 'event', id, result.rows[0].version, result.rows[0]);
      await audit(tx, actor.userId, 'event.edit', 'event', id, 'Event programming updated');
      return { data: result.rows[0] };
    });
  }
  async changeOccurrence(actor: Principal, id: string, raw: unknown) {
    const input = versionedReason
      .extend({
        action: z.enum(['reschedule', 'cancel']),
        startsAt: z.iso.datetime({ offset: true }).optional(),
        endsAt: z.iso.datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const result = await tx.query('SELECT * FROM occurrences WHERE id=$1 FOR UPDATE', [id]);
      const occurrence = result.rows[0];
      if (!occurrence) throw new ApiError('NOT_FOUND', 'Occurrence not found.', 404);
      await this.authorizeEvent(actor, occurrence.event_id, 'event.publish', tx);
      if (occurrence.version !== input.expectedVersion || occurrence.status === 'cancelled')
        throw new ApiError('VERSION_CONFLICT', 'Occurrence changed or was cancelled.', 409);
      if (
        input.action === 'reschedule' &&
        (!input.startsAt ||
          !input.endsAt ||
          Date.parse(input.endsAt) <= Date.parse(input.startsAt) ||
          !validZonedInstant(input.startsAt, occurrence.timezone) ||
          !validZonedInstant(input.endsAt, occurrence.timezone))
      )
        throw new ApiError('INVALID_LOCAL_TIME', 'Provide a valid interval in the event timezone.', 400);
      const updated =
        input.action === 'cancel'
          ? await tx.query(
              "UPDATE occurrences SET status='cancelled',version=version+1 WHERE id=$1 RETURNING *",
              [id],
            )
          : await tx.query(
              'UPDATE occurrences SET starts_at=$1,ends_at=$2,version=version+1 WHERE id=$3 RETURNING *',
              [input.startsAt, input.endsAt, id],
            );
      const changeId = randomUUID();
      // Physical table slots are exact appointments. A changed event does not silently move them.
      // Disable sales and entry in this transaction; provider refunds run through the durable outbox.
      await tx.query(
        'UPDATE table_offers SET active=false,version=version+1 WHERE occurrence_id=$1 AND active',
        [id],
      );
      await tx.query("UPDATE ticket_products SET active=false WHERE occurrence_id=$1 AND kind='table'", [id]);
      await tx.query(
        "UPDATE orders SET cancellation_requested=true WHERE occurrence_id=$1 AND snapshot ? 'table' AND status NOT IN ('cancelled','refunded')",
        [id],
      );
      await tx.query('INSERT INTO catalogue_changes(id,aggregate_id,kind,payload) VALUES($1,$2,$3,$4)', [
        changeId,
        id,
        input.action,
        JSON.stringify({ before: occurrence, after: updated.rows[0] }),
      ]);
      await enqueue(tx, 'catalogue.changed', changeId, { changeId });
      await revision(tx, actor, 'occurrence', id, updated.rows[0]!.version, updated.rows[0]);
      await audit(tx, actor.userId, `occurrence.${input.action}`, 'occurrence', id, input.reason);
      return { data: updated.rows[0] };
    });
  }
}
