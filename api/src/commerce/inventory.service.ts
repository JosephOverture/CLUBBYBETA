import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../platform/database';
import type { Principal } from '../identity/identity.service';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import { ApiError } from '../platform/http';

export const productInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    admissionConditions: z.string().max(3000).default(''),
    priceMinor: z.number().int().min(0).max(100000000),
    taxBps: z.number().int().min(0).max(10000),
    extraDrinkPriceMinor: z.number().int().min(0).max(100000000).nullable().default(null),
    extraDrinkLimit: z.number().int().min(0).max(10).default(0),
    extraDrinkTaxBps: z.number().int().min(0).max(10000).default(0),
    capacity: z.number().int().min(0).max(1000000),
    drinks: z.number().int().min(0).max(20),
    saleStartsAt: z.iso.datetime({ offset: true }),
    saleEndsAt: z.iso.datetime({ offset: true }),
    active: z.boolean(),
  })
  .strict();
export class InventoryService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
  ) {}
  async product(actor: Principal, occurrenceId: string, raw: unknown, id?: string) {
    const input = productInput
      .extend({ expectedVersion: z.number().int().positive().optional() })
      .strict()
      .parse(raw);
    if (Date.parse(input.saleEndsAt) <= Date.parse(input.saleStartsAt))
      throw new ApiError('INVALID_INTERVAL', 'Sales must end after they start.', 400);
    if (input.extraDrinkLimit > 0 && input.extraDrinkPriceMinor === null)
      throw new ApiError('INVALID_ADD_ON', 'Set a price for extra drink vouchers.', 400);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM occurrences WHERE id=$1 FOR UPDATE', [occurrenceId]);
      const occurrence = (
        await tx.query(
          'SELECT o.*,e.organization_id,e.venue_id FROM occurrences o JOIN events e ON e.id=o.event_id WHERE o.id=$1',
          [occurrenceId],
        )
      ).rows[0];
      if (!occurrence) throw new ApiError('NOT_FOUND', 'Occurrence not found.', 404);
      await this.organizations.authorize(
        actor,
        occurrence.organization_id,
        'event.edit',
        occurrence.venue_id,
        false,
        tx,
      );
      if (Date.parse(input.saleEndsAt) > occurrence.ends_at.getTime() || input.capacity > occurrence.capacity)
        throw new ApiError(
          'INVALID_INVENTORY',
          'Sales must end before the event ends and tier capacity cannot exceed event capacity.',
          400,
        );
      const productId = id ?? randomUUID();
      if (id) {
        const reserved = Number(
          (
            await tx.query(
              "SELECT coalesce(sum(quantity),0) AS qty FROM inventory_reservations WHERE product_id=$1 AND status<>'released'",
              [id],
            )
          ).rows[0].qty,
        );
        if (input.capacity < reserved)
          throw new ApiError(
            'CAPACITY_COMMITTED',
            'Capacity cannot be lower than reserved or sold admissions.',
            409,
          );
        const result = await tx.query(
          "UPDATE ticket_products SET name=$1,price_minor=$2,tax_bps=$3,capacity=$4,drinks=$5,sale_starts_at=$6,sale_ends_at=$7,active=$8,version=version+1 WHERE id=$9 AND occurrence_id=$10 AND version=$11 AND kind='ticket' RETURNING id",
          [
            input.name,
            input.priceMinor,
            input.taxBps,
            input.capacity,
            input.drinks,
            input.saleStartsAt,
            input.saleEndsAt,
            input.active,
            id,
            occurrenceId,
            input.expectedVersion,
          ],
        );
        if (!result.rowCount)
          throw new ApiError('VERSION_CONFLICT', 'Product changed or does not exist.', 409);
      } else
        await tx.query(
          'INSERT INTO ticket_products(id,occurrence_id,name,price_minor,tax_bps,capacity,drinks,sale_starts_at,sale_ends_at,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            productId,
            occurrenceId,
            input.name,
            input.priceMinor,
            input.taxBps,
            input.capacity,
            input.drinks,
            input.saleStartsAt,
            input.saleEndsAt,
            input.active,
          ],
        );
      await tx.query(
        'UPDATE ticket_products SET admission_conditions=$1,extra_drink_price_minor=$2,extra_drink_limit=$3,extra_drink_tax_bps=$4 WHERE id=$5',
        [
          input.admissionConditions,
          input.extraDrinkPriceMinor,
          input.extraDrinkLimit,
          input.extraDrinkTaxBps,
          productId,
        ],
      );
      await audit(
        tx,
        actor.userId,
        'inventory.product',
        'product',
        productId,
        'Ticket product configuration updated',
        input,
      );
      return { data: (await tx.query('SELECT * FROM ticket_products WHERE id=$1', [productId])).rows[0] };
    });
  }
  async promotion(actor: Principal, organizationId: string, raw: unknown) {
    const input = z
      .object({
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9_-]{4,40}$/),
        discountBps: z.number().int().min(1).max(10000),
        maxUses: z.number().int().min(1).max(1000000),
        expiresAt: z.iso.datetime({ offset: true }),
        occurrenceId: z.string().uuid().optional(),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await this.organizations.authorize(actor, organizationId, 'members.manage', undefined, false, tx);
      if (
        input.occurrenceId &&
        !(
          await tx.query(
            'SELECT o.id FROM occurrences o JOIN events e ON e.id=o.event_id WHERE o.id=$1 AND e.organization_id=$2',
            [input.occurrenceId, organizationId],
          )
        ).rowCount
      )
        throw new ApiError('NOT_FOUND', 'Occurrence not found for this seller.', 404);
      const id = randomUUID();
      await tx.query(
        'INSERT INTO promotion_codes(id,organization_id,occurrence_id,code,discount_bps,max_uses,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          organizationId,
          input.occurrenceId ?? null,
          input.code,
          input.discountBps,
          input.maxUses,
          input.expiresAt,
        ],
      );
      await audit(tx, actor.userId, 'inventory.promotion', 'promotion', id, 'Promotion created');
      return { data: { id } };
    });
  }
  async offers(occurrenceId: string) {
    const result = await this.db.query(
      `SELECT p.id,p.name,p.admission_conditions AS "admissionConditions",p.price_minor AS "priceMinor",p.tax_bps AS "taxBps",p.drinks,p.extra_drink_price_minor AS "extraDrinkPriceMinor",p.extra_drink_limit AS "extraDrinkLimit",o.currency,
      greatest(0,least(p.capacity-coalesce((SELECT sum(r.quantity) FROM inventory_reservations r WHERE r.product_id=p.id AND r.status<>'released'),0),
      o.capacity-coalesce((SELECT sum(r.quantity) FROM inventory_reservations r WHERE r.occurrence_id=o.id AND r.status<>'released'),0)-coalesce((SELECT sum(b.quantity) FROM inventory_blocks b WHERE b.occurrence_id=o.id AND b.released_at IS NULL),0)))::int AS available,
      p.sale_starts_at AS "saleStartsAt",p.sale_ends_at AS "saleEndsAt"
      FROM ticket_products p JOIN occurrences o ON o.id=p.occurrence_id JOIN events e ON e.id=o.event_id JOIN venues v ON v.id=e.venue_id JOIN destinations d ON d.id=v.destination_id
      WHERE o.id=$1 AND p.kind='ticket' AND p.active AND o.status='published' AND e.status='published' AND v.status='published' AND d.published AND v.commercial_mode='native' AND e.external_url IS NULL
      AND o.ends_at>now() ORDER BY p.price_minor,p.id`,
      [z.string().uuid().parse(occurrenceId)],
    );
    return { data: result.rows };
  }
  async capacity(actor: Principal, id: string, raw: unknown) {
    const input = z
      .object({
        capacity: z.number().int().min(0).max(1000000),
        expectedVersion: z.number().int().positive(),
        reason: z.string().min(10).max(1000),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const occurrence = (await tx.query('SELECT * FROM occurrences WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!occurrence) throw new ApiError('NOT_FOUND', 'Occurrence not found.', 404);
      const event = (await tx.query('SELECT venue_id FROM events WHERE id=$1', [occurrence.event_id]))
        .rows[0]!;
      await this.organizations.authorizeVenue(actor, event.venue_id, 'event.publish', tx);
      const count = Number(
        (
          await tx.query(
            "SELECT (SELECT coalesce(sum(quantity),0) FROM inventory_reservations WHERE occurrence_id=$1 AND status<>'released')+(SELECT coalesce(sum(quantity),0) FROM inventory_blocks WHERE occurrence_id=$1 AND released_at IS NULL) AS qty",
            [id],
          )
        ).rows[0].qty,
      );
      if (input.capacity < count)
        throw new ApiError('CAPACITY_COMMITTED', 'Capacity is below sold, held or blocked admissions.', 409);
      const updated = await tx.query(
        'UPDATE occurrences SET capacity=$1,version=version+1 WHERE id=$2 AND version=$3 RETURNING id,capacity,version',
        [input.capacity, id, input.expectedVersion],
      );
      if (!updated.rowCount) throw new ApiError('VERSION_CONFLICT', 'Occurrence changed.', 409);
      await audit(tx, actor.userId, 'inventory.capacity', 'occurrence', id, input.reason);
      return { data: updated.rows[0] };
    });
  }
  async block(actor: Principal, id: string, raw: unknown) {
    const input = z
      .object({
        quantity: z.number().int().positive().max(1000000),
        reason: z.string().min(10).max(1000),
        releaseId: z.string().uuid().optional(),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const occurrence = (await tx.query('SELECT * FROM occurrences WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!occurrence) throw new ApiError('NOT_FOUND', 'Occurrence not found.', 404);
      const event = (await tx.query('SELECT venue_id FROM events WHERE id=$1', [occurrence.event_id]))
        .rows[0]!;
      await this.organizations.authorizeVenue(actor, event.venue_id, 'event.publish', tx);
      if (input.releaseId) {
        const released = await tx.query(
          'UPDATE inventory_blocks SET released_at=coalesce(released_at,now()) WHERE id=$1 AND occurrence_id=$2 RETURNING id',
          [input.releaseId, id],
        );
        if (!released.rowCount) throw new ApiError('NOT_FOUND', 'Inventory block not found.', 404);
        await audit(tx, actor.userId, 'inventory.unblock', 'inventory-block', input.releaseId, input.reason);
        return { data: { id: input.releaseId, released: true } };
      }
      const count = Number(
        (
          await tx.query(
            "SELECT (SELECT coalesce(sum(quantity),0) FROM inventory_reservations WHERE occurrence_id=$1 AND status<>'released')+(SELECT coalesce(sum(quantity),0) FROM inventory_blocks WHERE occurrence_id=$1 AND released_at IS NULL) AS qty",
            [id],
          )
        ).rows[0].qty,
      );
      if (count + input.quantity > occurrence.capacity)
        throw new ApiError('SOLD_OUT', 'Block exceeds remaining event capacity.', 409);
      const blockId = randomUUID();
      await tx.query(
        'INSERT INTO inventory_blocks(id,occurrence_id,quantity,reason,actor_id) VALUES($1,$2,$3,$4,$5)',
        [blockId, id, input.quantity, input.reason, actor.userId],
      );
      await audit(tx, actor.userId, 'inventory.block', 'inventory-block', blockId, input.reason);
      return { data: { id: blockId, released: false } };
    });
  }
}
