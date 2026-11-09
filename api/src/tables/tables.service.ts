import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../platform/database';
import { ApiError } from '../platform/http';
import type { Principal } from '../identity/identity.service';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import { OrdersService } from '../commerce/orders.service';
import { idempotent, journal, notifyBuyer } from '../commerce/core';
import { hash, decrypt } from '../platform/crypto';
import { validZonedInstant } from '../catalogue/catalogue.schemas';
import { tableProjection } from './projection';

const tableShape = z
  .object({
    id: z.string().uuid().optional(),
    label: z.string().trim().min(1).max(60),
    zoneId: z.string().min(1).max(50),
    seats: z.number().int().min(1).max(50),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0.02).max(0.5),
    height: z.number().min(0.02).max(0.5),
    rotation: z.number().min(0).max(359),
    shape: z.enum(['circle', 'rectangle']),
  })
  .strict();
export const layoutInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    zones: z
      .array(z.object({ id: z.string().min(1).max(50), label: z.string().min(1).max(80) }).strict())
      .min(1)
      .max(30),
    tables: z.array(tableShape).min(1).max(200),
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().min(10).max(1000),
  })
  .strict();
export const tableOfferInput = z
  .object({
    tableId: z.string().uuid(),
    slotStartsAt: z.iso.datetime({ offset: true }),
    slotEndsAt: z.iso.datetime({ offset: true }),
    minGuests: z.number().int().min(1).max(50),
    maxGuests: z.number().int().min(1).max(50),
    fullPriceMinor: z.number().int().min(1).max(100000000),
    depositMinor: z.number().int().positive().max(100000000).nullable(),
    taxBps: z.number().int().min(0).max(10000),
    drinksPerGuest: z.number().int().min(0).max(20),
    inclusions: z.string().min(5).max(3000),
    minimumSpendMinor: z.number().int().nonnegative().max(100000000),
    terms: z.string().min(20).max(5000),
    noShowAfterMinutes: z.number().int().min(0).max(1440),
    noShowPolicy: z.literal('retain-paid'),
    active: z.boolean(),
  })
  .strict();
export class TablesService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
    readonly orders: OrdersService,
  ) {}
  async layout(actor: Principal, venueId: string, raw: unknown) {
    const input = layoutInput.parse(raw);
    const zoneIds = new Set(input.zones.map((z) => z.id));
    const givenIds = input.tables.map((t) => t.id).filter(Boolean);
    if (zoneIds.size !== input.zones.length || new Set(givenIds).size !== givenIds.length)
      throw new ApiError('INVALID_LAYOUT', 'Zones and physical table identifiers must be unique.', 400);
    for (const table of input.tables) {
      const radians = (table.rotation * Math.PI) / 180;
      const width = Math.abs(table.width * Math.cos(radians)) + Math.abs(table.height * Math.sin(radians));
      const height = Math.abs(table.width * Math.sin(radians)) + Math.abs(table.height * Math.cos(radians));
      if (
        !zoneIds.has(table.zoneId) ||
        table.x - width / 2 < 0 ||
        table.x + width / 2 > 1 ||
        table.y - height / 2 < 0 ||
        table.y + height / 2 > 1
      )
        throw new ApiError(
          'INVALID_LAYOUT',
          'Every table must fit inside the floor plan and belong to a declared zone.',
          400,
        );
    }
    return this.db.transaction(async (tx) => {
      await this.organizations.authorizeVenue(actor, venueId, 'venue.edit', tx);
      await tx.query('SELECT id FROM venues WHERE id=$1 FOR UPDATE', [venueId]);
      const last = Number(
        (
          await tx.query('SELECT coalesce(max(version),0) AS version FROM venue_layouts WHERE venue_id=$1', [
            venueId,
          ])
        ).rows[0].version,
      );
      if (last !== input.expectedVersion)
        throw new ApiError('VERSION_CONFLICT', 'Layout changed. Reload before saving.', 409);
      const tables = [];
      for (const table of input.tables) {
        const id = table.id ?? randomUUID();
        const existing = (await tx.query('SELECT venue_id FROM physical_tables WHERE id=$1', [id])).rows[0];
        if (existing && existing.venue_id !== venueId)
          throw new ApiError('INVALID_LAYOUT', 'A table belongs to another venue.', 400);
        await tx.query('INSERT INTO physical_tables(id,venue_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [
          id,
          venueId,
        ]);
        if (
          (await tx.query('SELECT venue_id FROM physical_tables WHERE id=$1', [id])).rows[0].venue_id !==
          venueId
        )
          throw new ApiError('INVALID_LAYOUT', 'A table belongs to another venue.', 400);
        tables.push({ ...table, id });
      }
      const id = randomUUID(),
        version = last + 1;
      const content = { name: input.name, zones: input.zones, tables };
      await tx.query(
        'INSERT INTO venue_layouts(id,venue_id,version,content,actor_id) VALUES($1,$2,$3,$4,$5)',
        [id, venueId, version, JSON.stringify(content), actor.userId],
      );
      await audit(tx, actor.userId, 'table.layout', 'venue-layout', id, input.reason, { venueId, version });
      return { data: { id, version, content } };
    });
  }
  async layouts(actor: Principal, venueId: string) {
    await this.organizations.authorizeVenue(actor, venueId, 'venue.read');
    return {
      data: (
        await this.db.query(
          'SELECT id,version,content,created_at FROM venue_layouts WHERE venue_id=$1 ORDER BY version DESC LIMIT 50',
          [venueId],
        )
      ).rows,
    };
  }
  async pin(actor: Principal, occurrenceId: string, raw: unknown) {
    const input = z
      .object({
        layoutId: z.string().uuid(),
        expectedVersion: z.number().int().nonnegative(),
        reason: z.string().min(10).max(1000),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM occurrences WHERE id=$1 FOR UPDATE', [occurrenceId]);
      const occurrence = (
        await tx.query(
          'SELECT e.venue_id FROM occurrences o JOIN events e ON e.id=o.event_id WHERE o.id=$1',
          [occurrenceId],
        )
      ).rows[0];
      if (!occurrence) throw new ApiError('NOT_FOUND', 'Occurrence not found.', 404);
      await this.organizations.authorizeVenue(actor, occurrence.venue_id, 'event.publish', tx);
      if (
        !(
          await tx.query('SELECT id FROM venue_layouts WHERE id=$1 AND venue_id=$2', [
            input.layoutId,
            occurrence.venue_id,
          ])
        ).rowCount
      )
        throw new ApiError('NOT_FOUND', 'Layout not found for this venue.', 404);
      const current = (
        await tx.query('SELECT * FROM occurrence_layouts WHERE occurrence_id=$1', [occurrenceId])
      ).rows[0];
      if ((current?.version ?? 0) !== input.expectedVersion)
        throw new ApiError('VERSION_CONFLICT', 'The occurrence layout changed.', 409);
      if (
        (await tx.query('SELECT id FROM table_offers WHERE occurrence_id=$1 LIMIT 1', [occurrenceId]))
          .rowCount
      )
        throw new ApiError(
          'LAYOUT_COMMITTED',
          'An occurrence with table offers keeps its pinned layout. Create a new occurrence to use a different floor plan.',
          409,
        );
      await tx.query(
        'INSERT INTO occurrence_layouts(occurrence_id,layout_id,version) VALUES($1,$2,1) ON CONFLICT(occurrence_id) DO UPDATE SET layout_id=EXCLUDED.layout_id,version=occurrence_layouts.version+1',
        [occurrenceId, input.layoutId],
      );
      await audit(tx, actor.userId, 'table.layout.pin', 'occurrence', occurrenceId, input.reason, {
        layoutId: input.layoutId,
      });
      return { data: { layoutId: input.layoutId, version: (current?.version ?? 0) + 1 } };
    });
  }
  async offer(actor: Principal, occurrenceId: string, raw: unknown) {
    const input = tableOfferInput.parse(raw);
    if (
      input.minGuests > input.maxGuests ||
      input.minimumSpendMinor > input.fullPriceMinor ||
      (input.depositMinor !== null && input.depositMinor > input.fullPriceMinor)
    )
      throw new ApiError('INVALID_OFFER', 'Check the guest limits, package price and deposit.', 400);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM occurrences WHERE id=$1 FOR UPDATE', [occurrenceId]);
      const occurrence = (
        await tx.query(
          'SELECT o.*,e.venue_id FROM occurrences o JOIN events e ON e.id=o.event_id WHERE o.id=$1',
          [occurrenceId],
        )
      ).rows[0];
      if (!occurrence) throw new ApiError('NOT_FOUND', 'Occurrence not found.', 404);
      await this.organizations.authorizeVenue(actor, occurrence.venue_id, 'event.publish', tx);
      const layout = (
        await tx.query(
          'SELECT l.* FROM occurrence_layouts p JOIN venue_layouts l ON l.id=p.layout_id WHERE p.occurrence_id=$1',
          [occurrenceId],
        )
      ).rows[0];
      const table = layout?.content.tables.find((t: any) => t.id === input.tableId);
      if (!table || input.maxGuests > table.seats)
        throw new ApiError(
          'INVALID_TABLE',
          'Choose a table from the pinned layout within its seated capacity.',
          400,
        );
      if (
        !validZonedInstant(input.slotStartsAt, occurrence.timezone) ||
        !validZonedInstant(input.slotEndsAt, occurrence.timezone) ||
        Date.parse(input.slotEndsAt) <= Date.parse(input.slotStartsAt) ||
        Date.parse(input.slotStartsAt) < occurrence.starts_at.getTime() ||
        Date.parse(input.slotEndsAt) > occurrence.ends_at.getTime() ||
        Date.parse(input.slotStartsAt) <= Date.now()
      )
        throw new ApiError(
          'INVALID_INTERVAL',
          'The table slot must be a future interval inside the occurrence in its timezone.',
          400,
        );
      const id = randomUUID(),
        productId = randomUUID();
      await tx.query(
        "INSERT INTO ticket_products(id,occurrence_id,name,price_minor,tax_bps,capacity,drinks,sale_starts_at,sale_ends_at,active,admission_conditions,kind) VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,'table')",
        [
          productId,
          occurrenceId,
          `Table ${table.label}`,
          input.fullPriceMinor,
          input.taxBps,
          occurrence.capacity,
          input.drinksPerGuest,
          input.slotStartsAt,
          input.active,
          input.terms,
        ],
      );
      await tx.query(
        'INSERT INTO table_offers(id,occurrence_id,table_id,layout_id,product_id,slot_starts_at,slot_ends_at,min_guests,max_guests,full_price_minor,deposit_minor,tax_bps,inclusions,minimum_spend_minor,terms,no_show_after_minutes,no_show_policy,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
        [
          id,
          occurrenceId,
          input.tableId,
          layout.id,
          productId,
          input.slotStartsAt,
          input.slotEndsAt,
          input.minGuests,
          input.maxGuests,
          input.fullPriceMinor,
          input.depositMinor,
          input.taxBps,
          input.inclusions,
          input.minimumSpendMinor,
          input.terms,
          input.noShowAfterMinutes,
          input.noShowPolicy,
          input.active,
        ],
      );
      await audit(tx, actor.userId, 'table.offer', 'table-offer', id, 'Versioned table offer created');
      return { data: { id, productId, version: 1 } };
    });
  }
  async availability(occurrenceId: string) {
    const parent = (
      await this.db.query(
        `SELECT l.content,l.id AS "layoutId",o.currency,o.timezone FROM occurrence_layouts p JOIN venue_layouts l ON l.id=p.layout_id JOIN occurrences o ON o.id=p.occurrence_id JOIN events e ON e.id=o.event_id JOIN venues v ON v.id=e.venue_id JOIN destinations d ON d.id=v.destination_id WHERE o.id=$1 AND o.status='published' AND e.status='published' AND v.status='published' AND d.published AND v.commercial_mode='native' AND e.external_url IS NULL AND o.ends_at>now()`,
        [occurrenceId],
      )
    ).rows[0];
    if (!parent) throw new ApiError('NOT_FOUND', 'Published table layout not found.', 404);
    const offers = (
      await this.db.query(
        `SELECT f.id,f.table_id AS "tableId",f.slot_starts_at AS "slotStartsAt",f.slot_ends_at AS "slotEndsAt",f.min_guests AS "minGuests",f.max_guests AS "maxGuests",f.full_price_minor AS "fullPriceMinor",f.deposit_minor AS "depositMinor",f.inclusions,f.minimum_spend_minor AS "minimumSpendMinor",f.terms,f.version,
      (o.capacity-coalesce((SELECT sum(quantity) FROM inventory_reservations WHERE occurrence_id=o.id AND status<>'released'),0)-coalesce((SELECT sum(quantity) FROM inventory_blocks WHERE occurrence_id=o.id AND released_at IS NULL),0)>=f.min_guests AND NOT EXISTS(SELECT 1 FROM table_allocations a WHERE a.table_id=f.table_id AND a.status IN ('held','confirmed') AND a.occupied_range&&tstzrange(f.slot_starts_at,f.slot_ends_at,'[)'))) AS available FROM table_offers f JOIN occurrences o ON o.id=f.occurrence_id WHERE f.occurrence_id=$1 AND f.active AND f.slot_starts_at>now() ORDER BY f.slot_starts_at,f.table_id`,
        [occurrenceId],
      )
    ).rows;
    return { data: { ...parent, offers } };
  }
  async hold(actor: Principal, raw: unknown, key: unknown, sharedTx?: import('pg').PoolClient) {
    const input = z
      .object({
        offerId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
        guests: z.number().int().min(1).max(50),
        paymentMode: z.enum(['full', 'deposit']),
        email: z.string().email().max(254),
      })
      .strict()
      .parse(raw);
    const run = (tx: import('pg').PoolClient) =>
      idempotent(tx, actor.userId, 'table.hold', key, input, async () => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,42))', [actor.userId]);
        const location = (
          await tx.query('SELECT occurrence_id,table_id FROM table_offers WHERE id=$1', [input.offerId])
        ).rows[0];
        if (!location) throw new ApiError('NOT_FOUND', 'Table offer not found.', 404);
        await tx.query('SELECT id FROM occurrences WHERE id=$1 FOR UPDATE', [location.occurrence_id]);
        await tx.query('SELECT id FROM physical_tables WHERE id=$1 FOR UPDATE', [location.table_id]);
        const offer = (
          await tx.query(
            'SELECT f.*,l.content FROM table_offers f JOIN venue_layouts l ON l.id=f.layout_id WHERE f.id=$1 FOR SHARE OF f',
            [input.offerId],
          )
        ).rows[0]!;
        if (
          !offer.active ||
          offer.version !== input.expectedVersion ||
          offer.slot_starts_at.getTime() <= Date.now()
        )
          throw new ApiError('OFFER_CHANGED', 'This table offer changed or closed.', 409);
        if (input.guests < offer.min_guests || input.guests > offer.max_guests)
          throw new ApiError('INVALID_PARTY_SIZE', 'Party size is outside the table limits.', 400);
        if (input.paymentMode === 'deposit' && offer.deposit_minor === null)
          throw new ApiError('DEPOSIT_UNAVAILABLE', 'This table requires full payment.', 400);
        if (
          (
            await tx.query(
              "SELECT reservation_id FROM table_allocations WHERE table_id=$1 AND status IN ('held','confirmed') AND occupied_range&&tstzrange($2,$3,'[)')",
              [offer.table_id, offer.slot_starts_at, offer.slot_ends_at],
            )
          ).rowCount
        )
          throw new ApiError(
            'TABLE_UNAVAILABLE',
            'This physical table is already held or reserved for the slot.',
            409,
          );
        const amount = input.paymentMode === 'full' ? offer.full_price_minor : offer.deposit_minor;
        const snapshot = {
          offerId: offer.id,
          offerVersion: offer.version,
          layoutId: offer.layout_id,
          table: offer.content.tables.find((t: any) => t.id === offer.table_id),
          slotStartsAt: offer.slot_starts_at.toISOString(),
          slotEndsAt: offer.slot_ends_at.toISOString(),
          guests: input.guests,
          fullPriceMinor: offer.full_price_minor,
          onlineAmountMinor: amount,
          inclusions: offer.inclusions,
          minimumSpendMinor: offer.minimum_spend_minor,
          terms: offer.terms,
          noShowAfterMinutes: offer.no_show_after_minutes,
          noShowPolicy: offer.no_show_policy,
        };
        const order = await this.orders.hold(
          actor,
          {
            occurrenceId: offer.occurrence_id,
            items: [{ productId: offer.product_id, quantity: 1 }],
            email: input.email,
          },
          hash(`table-order:${String(key)}`),
          false,
          {
            tx,
            table: {
              productId: offer.product_id,
              guests: input.guests,
              onlineAmountMinor: amount,
              fullPriceMinor: offer.full_price_minor,
              slotStartsAt: snapshot.slotStartsAt,
              snapshot,
            },
          },
        );
        const id = randomUUID();
        await tx.query(
          'INSERT INTO table_reservations(id,offer_id,order_id,guests,full_price_minor,online_amount_minor,commission_minor,currency,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            id,
            offer.id,
            order.data.id,
            input.guests,
            offer.full_price_minor,
            amount,
            order.data.commissionMinor,
            order.data.currency,
            JSON.stringify(snapshot),
          ],
        );
        await tx.query(
          'INSERT INTO table_allocations(reservation_id,table_id,slot_starts_at,slot_ends_at) VALUES($1,$2,$3,$4)',
          [id, offer.table_id, offer.slot_starts_at, offer.slot_ends_at],
        );
        return {
          data: { reservationId: id, order: order.data, balanceDueMinor: offer.full_price_minor - amount },
        };
      });
    return sharedTx ? run(sharedTx) : this.db.transaction(run);
  }
  async view(actor: Principal, id: string, staff = false) {
    const row = (
      await this.db.query(
        'SELECT r.*,o.user_id,o.venue_id,o.organization_id,o.status AS order_status,coalesce((SELECT sum(c.amount_minor) FROM door_collections c WHERE c.reservation_id=r.id),0)::int AS door_collected_minor FROM table_reservations r JOIN orders o ON o.id=r.order_id WHERE r.id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new ApiError('NOT_FOUND', 'Table reservation not found.', 404);
    if (staff) await this.organizations.authorizeVenue(actor, row.venue_id, 'booking.read');
    else this.orders.owner(actor, row);
    return {
      data: {
        ...tableProjection(row),
        collections: (
          await this.db.query(
            'SELECT id,amount_minor AS "amountMinor",method,reference,reason,reversal_of AS "reversalOf",created_at AS "createdAt" FROM door_collections WHERE reservation_id=$1 ORDER BY created_at',
            [id],
          )
        ).rows,
      },
    };
  }
  async collect(actor: Principal, id: string, raw: unknown, key: unknown) {
    const input = z
      .object({
        amountMinor: z.number().int().positive().max(100000000),
        method: z.enum(['cash', 'external-card']),
        reference: z.string().trim().min(6).max(150),
        reason: z.string().min(10).max(1000),
      })
      .strict()
      .parse(raw);
    return this.db.transaction((tx) =>
      idempotent(tx, actor.userId, `table.collect:${id}`, key, input, async () => {
        const located = (await tx.query('SELECT order_id FROM table_reservations WHERE id=$1', [id])).rows[0];
        if (!located) throw new ApiError('NOT_FOUND', 'Reservation not found.', 404);
        const order = await this.orders.lock(tx, located.order_id);
        await this.organizations.authorizeVenue(actor, order.venue_id, 'booking.collect', tx);
        const reservation = (await tx.query('SELECT * FROM table_reservations WHERE id=$1 FOR UPDATE', [id]))
          .rows[0]!;
        if (
          reservation.status !== 'confirmed' ||
          !['paid', 'partially-refunded'].includes(order.status) ||
          order.dispute_open ||
          order.cancellation_requested
        )
          throw new ApiError('RESERVATION_INACTIVE', 'This reservation cannot collect a balance.', 409);
        const collected = Number(
          (
            await tx.query(
              'SELECT coalesce(sum(amount_minor),0) AS total FROM door_collections WHERE reservation_id=$1',
              [id],
            )
          ).rows[0].total,
        );
        if (input.amountMinor > reservation.full_price_minor - reservation.online_amount_minor - collected)
          throw new ApiError('BALANCE_EXCEEDED', 'Collection exceeds the outstanding table balance.', 409);
        const collectionId = randomUUID();
        await this.collectionReference(tx, order.venue_id, input.method, input.reference);
        await tx.query(
          'INSERT INTO door_collections(id,reservation_id,actor_id,amount_minor,method,reference,reason,venue_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            collectionId,
            id,
            actor.userId,
            input.amountMinor,
            input.method,
            input.reference,
            input.reason,
            order.venue_id,
          ],
        );
        await journal(
          tx,
          `door:${collectionId}`,
          order.currency,
          order.id,
          'Seller recorded door balance payment',
          { [`seller-${input.method}`]: input.amountMinor, 'seller-receivable': -input.amountMinor },
        );
        await audit(tx, actor.userId, 'table.collect', 'door-collection', collectionId, input.reason, {
          reservationId: id,
          amountMinor: input.amountMinor,
          method: input.method,
        });
        await notifyBuyer(
          tx,
          this.db.config,
          order.user_id,
          decrypt(order.buyer_email_encrypted, this.db.config.encryptionKeys) as string,
          'table-balance',
          'Table balance payment recorded',
          `Booking ${order.id}\nThe venue recorded ${input.amountMinor} ${order.currency} minor units by ${input.method}. Receipt: ${input.reference}\nRemaining: ${reservation.full_price_minor - reservation.online_amount_minor - collected - input.amountMinor} minor units.`,
          `door:${collectionId}`,
          { kind: 'booking', id: order.id },
        );
        return {
          data: {
            id: collectionId,
            balanceDueMinor:
              reservation.full_price_minor - reservation.online_amount_minor - collected - input.amountMinor,
          },
        };
      }),
    );
  }
  async reverseCollection(actor: Principal, id: string, raw: unknown, key: unknown) {
    const input = z
      .object({ reason: z.string().min(10).max(1000), reference: z.string().trim().min(6).max(150) })
      .strict()
      .parse(raw);
    return this.db.transaction((tx) =>
      idempotent(tx, actor.userId, `table.reverse:${id}`, key, input, async () => {
        const original = (
          await tx.query(
            'SELECT c.*,r.order_id FROM door_collections c JOIN table_reservations r ON r.id=c.reservation_id WHERE c.id=$1',
            [id],
          )
        ).rows[0];
        if (!original || original.amount_minor <= 0)
          throw new ApiError('NOT_FOUND', 'Positive door collection not found.', 404);
        const order = await this.orders.lock(tx, original.order_id);
        await this.organizations.authorizeVenue(actor, order.venue_id, 'booking.refund', tx);
        if ((await tx.query('SELECT id FROM door_collections WHERE reversal_of=$1', [id])).rowCount)
          throw new ApiError('ALREADY_REVERSED', 'This collection was already reversed.', 409);
        const reversalId = randomUUID();
        const reservation = (
          await tx.query('SELECT status FROM table_reservations WHERE id=$1', [original.reservation_id])
        ).rows[0]!;
        await this.collectionReference(tx, order.venue_id, original.method, input.reference);
        await tx.query(
          'INSERT INTO door_collections(id,reservation_id,actor_id,amount_minor,method,reference,reason,reversal_of,venue_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            reversalId,
            original.reservation_id,
            actor.userId,
            -original.amount_minor,
            original.method,
            input.reference,
            input.reason,
            id,
            order.venue_id,
          ],
        );
        await journal(
          tx,
          `door:${reversalId}`,
          order.currency,
          order.id,
          'Reasoned door collection reversal',
          {
            [`seller-${original.method}`]: -original.amount_minor,
            [reservation.status === 'no-show' ? 'seller-table-remaining' : 'seller-receivable']:
              original.amount_minor,
          },
        );
        await audit(
          tx,
          actor.userId,
          'table.collection.reverse',
          'door-collection',
          reversalId,
          input.reason,
          { originalId: id },
        );
        await tx.query(
          "UPDATE table_reservations SET status='cancelled' WHERE id=$1 AND status='refund-review' AND (SELECT coalesce(sum(amount_minor),0) FROM door_collections WHERE reservation_id=$1)=0",
          [original.reservation_id],
        );
        return { data: { id: reversalId } };
      }),
    );
  }
  async noShow(actor: Principal, id: string, reason: string) {
    return this.db.transaction(async (tx) => {
      const located = (await tx.query('SELECT order_id FROM table_reservations WHERE id=$1', [id])).rows[0];
      if (!located) throw new ApiError('NOT_FOUND', 'Reservation not found.', 404);
      const order = await this.orders.lock(tx, located.order_id);
      await this.organizations.authorizeVenue(actor, order.venue_id, 'event.publish', tx);
      const reservation = (await tx.query('SELECT * FROM table_reservations WHERE id=$1 FOR UPDATE', [id]))
        .rows[0]!;
      if (
        reservation.status !== 'confirmed' ||
        order.status !== 'paid' ||
        order.dispute_open ||
        order.cancellation_requested ||
        Date.now() <
          Date.parse(reservation.snapshot.slotStartsAt) + reservation.snapshot.noShowAfterMinutes * 60_000
      )
        throw new ApiError('NO_SHOW_UNAVAILABLE', 'This reservation cannot yet be marked as a no-show.', 409);
      if (
        (
          await tx.query('SELECT id FROM tickets WHERE order_id=$1 AND admitted_at IS NOT NULL LIMIT 1', [
            order.id,
          ])
        ).rowCount
      )
        throw new ApiError('GUESTS_ADMITTED', 'A guest already arrived.', 409);
      await tx.query("UPDATE table_reservations SET status='no-show' WHERE id=$1", [id]);
      await tx.query("UPDATE table_allocations SET status='released' WHERE reservation_id=$1", [id]);
      await tx.query("UPDATE tickets SET status='void' WHERE order_id=$1 AND status='valid'", [order.id]);
      await tx.query("UPDATE inventory_reservations SET status='released' WHERE order_id=$1", [order.id]);
      const collected = Number(
        (
          await tx.query(
            'SELECT coalesce(sum(amount_minor),0) AS total FROM door_collections WHERE reservation_id=$1',
            [id],
          )
        ).rows[0].total,
      );
      const waived = reservation.full_price_minor - reservation.online_amount_minor - collected;
      await journal(
        tx,
        `table-no-show:${id}`,
        order.currency,
        order.id,
        'No-show retains paid money and waives uncollected balance',
        { 'seller-table-remaining': waived, 'seller-receivable': -waived },
      );
      await audit(
        tx,
        actor.userId,
        'table.no-show',
        'table-reservation',
        id,
        z.string().min(10).max(1000).parse(reason),
      );
      return { data: { status: 'no-show', retainedMinor: reservation.online_amount_minor + collected } };
    });
  }
  private async collectionReference(
    tx: import('pg').PoolClient,
    venueId: string,
    method: string,
    reference: string,
  ) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,51))', [
      `${venueId}:${method}:${reference}`,
    ]);
    if (
      (
        await tx.query('SELECT id FROM door_collections WHERE venue_id=$1 AND method=$2 AND reference=$3', [
          venueId,
          method,
          reference,
        ])
      ).rowCount
    )
      throw new ApiError(
        'RECEIPT_ALREADY_RECORDED',
        'This receipt has already been recorded for the venue.',
        409,
      );
  }
  async block(actor: Principal, tableId: string, raw: unknown, key: unknown) {
    const input = z
      .object({
        startsAt: z.iso.datetime({ offset: true }),
        endsAt: z.iso.datetime({ offset: true }),
        reason: z.string().min(10).max(1000),
      })
      .strict()
      .parse(raw);
    return this.db.transaction((tx) =>
      idempotent(tx, actor.userId, `table.block:${tableId}`, key, input, async () => {
        const table = (
          await tx.query(
            'SELECT t.venue_id,d.timezone FROM physical_tables t JOIN venues v ON v.id=t.venue_id JOIN destinations d ON d.id=v.destination_id WHERE t.id=$1 FOR UPDATE OF t',
            [tableId],
          )
        ).rows[0];
        if (!table) throw new ApiError('NOT_FOUND', 'Physical table not found.', 404);
        await this.organizations.authorizeVenue(actor, table.venue_id, 'event.publish', tx);
        if (
          !validZonedInstant(input.startsAt, table.timezone) ||
          !validZonedInstant(input.endsAt, table.timezone) ||
          Date.parse(input.endsAt) <= Math.max(Date.now(), Date.parse(input.startsAt))
        )
          throw new ApiError(
            'INVALID_INTERVAL',
            'Provide a valid table block interval in the venue timezone.',
            400,
          );
        if (
          (
            await tx.query(
              "SELECT id FROM table_allocations WHERE table_id=$1 AND status IN ('held','confirmed') AND occupied_range&&tstzrange($2,$3,'[)')",
              [tableId, input.startsAt, input.endsAt],
            )
          ).rowCount
        )
          throw new ApiError(
            'TABLE_UNAVAILABLE',
            'This block overlaps an active hold, reservation or block.',
            409,
          );
        const id = randomUUID();
        await tx.query(
          "INSERT INTO table_allocations(id,table_id,slot_starts_at,slot_ends_at,status,block_actor_id,block_reason) VALUES($1,$2,$3,$4,'confirmed',$5,$6)",
          [id, tableId, input.startsAt, input.endsAt, actor.userId, input.reason],
        );
        await audit(tx, actor.userId, 'table.block', 'table-allocation', id, input.reason, { tableId });
        return { data: { id } };
      }),
    );
  }
  async releaseBlock(actor: Principal, id: string, reason: string) {
    z.string().min(10).max(1000).parse(reason);
    return this.db.transaction(async (tx) => {
      const block = (
        await tx.query(
          'SELECT a.table_id,t.venue_id FROM table_allocations a JOIN physical_tables t ON t.id=a.table_id WHERE a.id=$1 AND a.reservation_id IS NULL FOR UPDATE OF t',
          [id],
        )
      ).rows[0];
      if (!block) throw new ApiError('NOT_FOUND', 'Table block not found.', 404);
      await this.organizations.authorizeVenue(actor, block.venue_id, 'event.publish', tx);
      await tx.query("UPDATE table_allocations SET status='released' WHERE id=$1", [id]);
      await audit(tx, actor.userId, 'table.block.release', 'table-allocation', id, reason);
      return { data: { released: true } };
    });
  }
  async blocks(actor: Principal, venueId: string) {
    await this.organizations.authorizeVenue(actor, venueId, 'venue.read');
    return {
      data: (
        await this.db.query(
          'SELECT a.id,a.table_id AS "tableId",a.slot_starts_at AS "startsAt",a.slot_ends_at AS "endsAt",a.block_reason AS reason FROM table_allocations a JOIN physical_tables t ON t.id=a.table_id WHERE t.venue_id=$1 AND a.reservation_id IS NULL AND a.status<>\'released\' AND a.slot_ends_at>now() ORDER BY a.slot_starts_at LIMIT 200',
          [venueId],
        )
      ).rows,
    };
  }
  async offerStatus(actor: Principal, id: string, raw: unknown) {
    const input = z
      .object({
        expectedVersion: z.number().int().positive(),
        active: z.boolean(),
        reason: z.string().min(10).max(1000),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const found = (await tx.query('SELECT occurrence_id FROM table_offers WHERE id=$1', [id])).rows[0];
      if (!found) throw new ApiError('NOT_FOUND', 'Table offer not found.', 404);
      await tx.query('SELECT id FROM occurrences WHERE id=$1 FOR UPDATE', [found.occurrence_id]);
      const offer = (
        await tx.query(
          'SELECT f.*,e.venue_id,o.starts_at,o.ends_at,o.status AS occurrence_status FROM table_offers f JOIN occurrences o ON o.id=f.occurrence_id JOIN events e ON e.id=o.event_id WHERE f.id=$1 FOR UPDATE OF f',
          [id],
        )
      ).rows[0]!;
      await this.organizations.authorizeVenue(actor, offer.venue_id, 'event.publish', tx);
      if (offer.version !== input.expectedVersion)
        throw new ApiError('VERSION_CONFLICT', 'Table offer changed.', 409);
      if (
        input.active &&
        (offer.occurrence_status !== 'published' ||
          offer.slot_starts_at.getTime() <= Date.now() ||
          offer.slot_starts_at < offer.starts_at ||
          offer.slot_ends_at > offer.ends_at)
      )
        throw new ApiError('OFFER_CLOSED', 'This slot cannot be published in the current occurrence.', 409);
      await tx.query('UPDATE table_offers SET active=$1,version=version+1 WHERE id=$2', [input.active, id]);
      await tx.query('UPDATE ticket_products SET active=$1 WHERE id=$2', [input.active, offer.product_id]);
      await audit(tx, actor.userId, 'table.offer.publication', 'table-offer', id, input.reason, {
        active: input.active,
      });
      return { data: { id, active: input.active, version: offer.version + 1 } };
    });
  }
}
