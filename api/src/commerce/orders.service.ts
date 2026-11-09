import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Database } from '../platform/database';
import type { Principal } from '../identity/identity.service';
import { ApiError } from '../platform/http';
import { encrypt, decrypt, hash, secret } from '../platform/crypto';
import { enqueue } from '../platform/jobs';
import { audit, OrganizationsService } from '../organizations/organizations.service';
import { idempotent, distribute, journal, notifyBuyer } from './core';
import type { Payment, PaymentProvider } from './provider';
import { tableProjection } from '../tables/projection';
import { assertContributionPayable, cancelGroup, groupMoneyChanged } from '../groups/group-events';
import { SavedMethodsService } from './saved-methods.service';

export const orderInput = z
  .object({
    occurrenceId: z.string().uuid(),
    items: z
      .array(
        z
          .object({
            productId: z.string().uuid(),
            quantity: z.number().int().min(1).max(8),
            extraDrinks: z.number().int().min(0).max(10).default(0),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    email: z
      .string()
      .email()
      .max(254)
      .transform((s) => s.toLowerCase()),
    promotionCode: z.string().trim().toUpperCase().max(40).optional(),
  })
  .strict();
class QuoteRollback extends Error {
  constructor(readonly result: any) {
    super('Quote transaction rollback');
  }
}
export type InternalTableHold = {
  tx: PoolClient;
  table: {
    productId: string;
    guests: number;
    onlineAmountMinor: number;
    fullPriceMinor: number;
    slotStartsAt: string;
    snapshot: Record<string, unknown>;
  };
};
export class OrdersService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
    readonly provider: PaymentProvider,
    readonly savedMethods = new SavedMethodsService(db, organizations, provider),
  ) {}
  async hold(actor: Principal, raw: unknown, key: unknown, quoteOnly = false, internal?: InternalTableHold) {
    if (internal && quoteOnly) throw new Error('A quote must own its rollback transaction.');
    const input = orderInput.parse(raw);
    input.items.sort((a, b) => a.productId.localeCompare(b.productId));
    const quantity = internal?.table.guests ?? input.items.reduce((sum, line) => sum + line.quantity, 0);
    if (
      quantity > (internal ? 50 : 8) ||
      new Set(input.items.map((i) => i.productId)).size !== input.items.length
    )
      throw new ApiError('INVALID_QUANTITY', 'Select up to eight admissions and each product once.', 400);
    if (actor.kind === 'registered' && actor.email !== input.email)
      throw new ApiError('EMAIL_MISMATCH', 'Use the email verified on your account.', 400);
    if (this.db.config.STRIPE_MODE === 'disabled')
      throw new ApiError('PAYMENTS_NOT_CONFIGURED', 'Native checkout is not configured.', 503);
    try {
      const operation = (tx: PoolClient) =>
        idempotent(
          tx,
          actor.userId,
          'order.hold',
          key,
          internal ? { input, table: internal.table } : input,
          async () => {
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,42))', [actor.userId]);
            if (
              Number(
                (
                  await tx.query(
                    "SELECT count(*) AS count FROM orders WHERE user_id=$1 AND status IN ('held','payment-pending')",
                    [actor.userId],
                  )
                ).rows[0].count,
              ) >= 3
            )
              throw new ApiError('HOLD_LIMIT', 'Finish or cancel an existing checkout first.', 429);
            await tx.query('SELECT id FROM occurrences WHERE id=$1 FOR UPDATE', [input.occurrenceId]);
            const event = (
              await tx.query(
                `SELECT o.*,e.title,e.organization_id,e.venue_id,e.status AS event_status,e.external_url,
        v.name AS venue_name,v.minimum_age,v.commercial_mode,v.status AS venue_status,d.published,d.native_sales_enabled,
        r.seller_countries,(r.expires_at>now() AND r.country_code=d.country_code AND r.currency=o.currency AND r.currency=d.currency AND r.timezone=d.timezone) AS market_review_valid,
        s.new_sales_paused FROM occurrences o JOIN events e ON e.id=o.event_id JOIN venues v ON v.id=e.venue_id JOIN destinations d ON d.id=v.destination_id LEFT JOIN market_reviews r ON r.id=d.market_review_id CROSS JOIN public_settings s WHERE o.id=$1`,
                [input.occurrenceId],
              )
            ).rows[0];
            if (
              !event ||
              event.status !== 'published' ||
              event.event_status !== 'published' ||
              event.venue_status !== 'published' ||
              !event.published ||
              event.ends_at.getTime() <= Date.now()
            )
              throw new ApiError('NOT_ON_SALE', 'This occurrence is not available for purchase.', 409);
            if (event.commercial_mode !== 'native' || event.external_url)
              throw new ApiError('EXTERNAL_CHECKOUT', 'Purchase this event from its external seller.', 409);
            if (event.new_sales_paused || !event.native_sales_enabled || !event.market_review_valid)
              throw new ApiError('SALES_PAUSED', 'New sales are currently paused in this market.', 409);
            const seller = (
              await tx.query(
                `SELECT a.*,o.status AS organization_status,o.privacy_sales_paused,o.application,o.name AS seller_name,o.country_code AS seller_country FROM seller_accounts a JOIN organizations o ON o.id=a.organization_id WHERE a.organization_id=$1 FOR SHARE OF a,o`,
                [event.organization_id],
              )
            ).rows[0];
            if (
              !seller ||
              seller.privacy_sales_paused ||
              !event.seller_countries?.includes(seller.seller_country) ||
              seller.organization_status !== 'approved' ||
              seller.status !== 'ready' ||
              !seller.charges_enabled ||
              !seller.payouts_enabled ||
              !seller.configuration_valid ||
              seller.livemode !== (this.db.config.STRIPE_MODE === 'live') ||
              !seller.synced_at ||
              Date.now() - seller.synced_at.getTime() > 15 * 60_000
            )
              throw new ApiError(
                'SELLER_NOT_READY',
                'Seller payment capabilities must be verified before checkout.',
                409,
              );
            const policy = (
              await tx.query(
                `SELECT p.*,a.accepted_at FROM commercial_policies p LEFT JOIN policy_acceptances a ON a.policy_id=p.id WHERE p.organization_id=$1 ORDER BY p.version DESC LIMIT 1`,
                [event.organization_id],
              )
            ).rows[0];
            if (!policy?.accepted_at)
              throw new ApiError('POLICY_REQUIRED', 'Seller must accept the current commercial terms.', 409);
            const products = (
              await tx.query(
                'SELECT * FROM ticket_products WHERE id=ANY($1::uuid[]) AND occurrence_id=$2 ORDER BY id FOR UPDATE',
                [input.items.map((i) => i.productId), input.occurrenceId],
              )
            ).rows;
            if (products.length !== input.items.length)
              throw new ApiError(
                'INVALID_PRODUCT',
                'One or more products do not belong to this occurrence.',
                400,
              );
            // Read committed stock in a separate statement AFTER the occurrence lock is acquired.
            const committed = Number(
              (
                await tx.query(
                  "SELECT coalesce(sum(quantity),0) AS qty FROM inventory_reservations WHERE occurrence_id=$1 AND status<>'released'",
                  [input.occurrenceId],
                )
              ).rows[0].qty,
            );
            const blocked = Number(
              (
                await tx.query(
                  'SELECT coalesce(sum(quantity),0) AS qty FROM inventory_blocks WHERE occurrence_id=$1 AND released_at IS NULL',
                  [input.occurrenceId],
                )
              ).rows[0].qty,
            );
            if (committed + blocked + quantity > event.capacity)
              throw new ApiError('SOLD_OUT', 'The requested admissions are no longer available.', 409);
            let promotion: any;
            if (input.promotionCode) {
              promotion = (
                await tx.query(
                  'SELECT * FROM promotion_codes WHERE organization_id=$1 AND code=$2 FOR UPDATE',
                  [event.organization_id, input.promotionCode],
                )
              ).rows[0];
              const uses = promotion
                ? Number(
                    (
                      await tx.query(
                        "SELECT count(*) AS count FROM promotion_uses WHERE promotion_id=$1 AND status<>'released'",
                        [promotion.id],
                      )
                    ).rows[0].count,
                  )
                : 0;
              if (
                !promotion ||
                !promotion.active ||
                promotion.expires_at.getTime() <= Date.now() ||
                (promotion.occurrence_id && promotion.occurrence_id !== input.occurrenceId) ||
                uses >= promotion.max_uses
              )
                throw new ApiError('INVALID_PROMOTION', 'This promotion is unavailable.', 409);
            }
            const lines = [];
            let total = 0,
              discount = 0,
              tax = 0;
            for (const product of products) {
              const item = input.items.find((i) => i.productId === product.id)!;
              if (product.kind !== 'ticket' && (!internal || internal.table.productId !== product.id))
                throw new ApiError(
                  'INVALID_PRODUCT',
                  'Table offers require the exclusive reservation workflow.',
                  400,
                );
              if (
                internal &&
                (products.length !== 1 ||
                  product.kind !== 'table' ||
                  item.quantity !== 1 ||
                  item.extraDrinks !== 0 ||
                  input.promotionCode)
              )
                throw new Error('Invalid internal table order.');
              const admissions = internal?.table.guests ?? item.quantity;
              if (
                !product.active ||
                product.sale_starts_at.getTime() > Date.now() ||
                product.sale_ends_at.getTime() <= Date.now()
              )
                throw new ApiError('NOT_ON_SALE', 'A selected product is not on sale.', 409);
              const used = Number(
                (
                  await tx.query(
                    "SELECT coalesce(sum(quantity),0) AS qty FROM inventory_reservations WHERE product_id=$1 AND status<>'released'",
                    [product.id],
                  )
                ).rows[0].qty,
              );
              if (used + admissions > product.capacity)
                throw new ApiError('SOLD_OUT', 'A selected ticket tier is sold out.', 409);
              if (
                item.extraDrinks > product.extra_drink_limit ||
                (item.extraDrinks > 0 && product.extra_drink_price_minor === null)
              )
                throw new ApiError(
                  'INVALID_ADD_ON',
                  'The requested extra drink vouchers are unavailable.',
                  400,
                );
              const admissionGross = internal?.table.onlineAmountMinor ?? product.price_minor * item.quantity;
              const drinkGross = item.extraDrinks * (product.extra_drink_price_minor ?? 0) * item.quantity;
              const gross = admissionGross + drinkGross;
              const reduction = Math.floor((gross * (promotion?.discount_bps ?? 0)) / 10000);
              const net = gross - reduction;
              const admissionNet = gross ? Math.floor((net * admissionGross) / gross) : 0;
              const drinkNet = net - admissionNet;
              const inclusiveTax =
                Math.round((admissionNet * product.tax_bps) / (10000 + product.tax_bps)) +
                Math.round((drinkNet * product.extra_drink_tax_bps) / (10000 + product.extra_drink_tax_bps));
              lines.push({
                product,
                extraDrinks: item.extraDrinks,
                quantity: item.quantity,
                admissions,
                amount: net,
                tax: inclusiveTax,
              });
              total += net;
              discount += reduction;
              tax += inclusiveTax;
            }
            if (total > 100000000)
              throw new ApiError('ORDER_TOO_LARGE', 'Order exceeds the supported monetary limit.', 400);
            const commission = Math.floor(
              ((internal?.table.fullPriceMinor ?? total) * policy.commission_bps) / 10000,
            );
            if (commission > total)
              throw new ApiError(
                'DEPOSIT_TOO_SMALL',
                'The deposit must cover the application fee on the full table package.',
                409,
              );
            const id = randomUUID();
            const expiresAt = new Date(
              Math.min(
                Date.now() + 10 * 60_000,
                event.ends_at.getTime(),
                internal ? Date.parse(internal.table.slotStartsAt) : Infinity,
              ),
            );
            const snapshot = {
              title: event.title,
              venueName: event.venue_name,
              sellerLegalName: seller.application.legalName ?? seller.seller_name,
              minimumAge: event.minimum_age,
              startsAt: event.starts_at.toISOString(),
              endsAt: event.ends_at.toISOString(),
              timezone: event.timezone,
              occurrenceVersion: event.version,
              policyVersion: policy.version,
              terms: policy.terms,
              refundCutoffHours: policy.refund_cutoff_hours,
              refundCommission: policy.refund_commission,
              taxRegistration: policy.tax_registration,
              ...(internal ? { table: internal.table.snapshot } : {}),
            };
            await tx.query(
              'INSERT INTO orders(id,user_id,buyer_email_encrypted,buyer_email_hash,occurrence_id,venue_id,organization_id,policy_id,account_id,currency,total_minor,commission_minor,discount_minor,tax_minor,quantity,snapshot,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
              [
                id,
                actor.userId,
                encrypt(input.email, this.db.config.encryptionKeys),
                hash(input.email),
                input.occurrenceId,
                event.venue_id,
                event.organization_id,
                policy.id,
                seller.account_id,
                event.currency,
                total,
                commission,
                discount,
                tax,
                quantity,
                JSON.stringify(snapshot),
                expiresAt,
              ],
            );
            await tx.query('UPDATE orders SET channel=$1 WHERE id=$2', [actor.channel, id]);
            let remainingCommission = commission;
            let remainingTotal = total;
            for (const line of lines) {
              const fee = remainingTotal
                ? Math.floor((remainingCommission * line.amount) / remainingTotal)
                : 0;
              remainingCommission -= fee;
              remainingTotal -= line.amount;
              await tx.query(
                'INSERT INTO order_lines(id,order_id,product_id,quantity,unit_minor,total_minor,commission_minor,tax_minor,snapshot,admission_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                [
                  randomUUID(),
                  id,
                  line.product.id,
                  line.quantity,
                  line.product.price_minor,
                  line.amount,
                  fee,
                  line.tax,
                  JSON.stringify({
                    name: line.product.name,
                    drinks: line.product.drinks + line.extraDrinks,
                    extraDrinks: line.extraDrinks,
                    extraDrinkUnitMinor: line.product.extra_drink_price_minor,
                    extraDrinkTaxBps: line.product.extra_drink_tax_bps,
                    version: line.product.version,
                    taxBps: line.product.tax_bps,
                    admissionConditions: line.product.admission_conditions,
                  }),
                  line.admissions,
                ],
              );
              await tx.query(
                "INSERT INTO inventory_reservations(order_id,product_id,occurrence_id,quantity,status) VALUES($1,$2,$3,$4,'held')",
                [id, line.product.id, input.occurrenceId, line.admissions],
              );
            }
            if (promotion)
              await tx.query(
                "INSERT INTO promotion_uses(promotion_id,order_id,status) VALUES($1,$2,'reserved')",
                [promotion.id, id],
              );
            const result = {
              data: {
                id,
                status: 'held',
                expiresAt: expiresAt.toISOString(),
                totalMinor: total,
                commissionMinor: commission,
                discountMinor: discount,
                taxMinor: tax,
                currency: event.currency,
                quantity,
                snapshot,
              },
            };
            if (quoteOnly) throw new QuoteRollback(result);
            return result;
          },
        );
      return await (internal ? operation(internal.tx) : this.db.transaction(operation));
    } catch (error) {
      if (quoteOnly && error instanceof QuoteRollback)
        return error.result as {
          data: {
            id: string;
            status: string;
            expiresAt: string;
            totalMinor: number;
            commissionMinor: number;
            discountMinor: number;
            taxMinor: number;
            currency: string;
            quantity: number;
            snapshot: any;
          };
        };
      throw error;
    }
  }
  async quote(actor: Principal, raw: unknown) {
    const {
      id: _id,
      expiresAt: _expires,
      status: _status,
      ...totals
    } = (await this.hold(actor, raw, randomUUID(), true)).data;
    return { data: { ...totals, reserved: false } };
  }
  async lock(tx: PoolClient, id: string) {
    const location = (await tx.query('SELECT occurrence_id FROM orders WHERE id=$1', [id])).rows[0];
    if (!location) throw new ApiError('NOT_FOUND', 'Order not found.', 404);
    await tx.query('SELECT id FROM occurrences WHERE id=$1 FOR UPDATE', [location.occurrence_id]);
    return (await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
  }
  owner(actor: Principal, order: any) {
    if (order.user_id !== actor.userId) throw new ApiError('NOT_FOUND', 'Order not found.', 404);
  }
  async view(actor: Principal, id: string) {
    const order = (await this.db.query('SELECT * FROM orders WHERE id=$1', [z.string().uuid().parse(id)]))
      .rows[0];
    if (!order) throw new ApiError('NOT_FOUND', 'Order not found.', 404);
    this.owner(actor, order);
    return { data: await this.present(order) };
  }
  async present(order: any) {
    const group = (
      await this.db.query(
        'SELECT g.id FROM booking_groups g WHERE g.order_id=$1 OR g.id IN (SELECT group_id FROM group_contributions WHERE order_id=$1)',
        [order.id],
      )
    ).rows[0];
    const table = (
      await this.db.query(
        'SELECT r.*,coalesce((SELECT sum(c.amount_minor) FROM door_collections c WHERE c.reservation_id=r.id),0)::int AS door_collected_minor FROM table_reservations r WHERE r.order_id=$1',
        [order.id],
      )
    ).rows[0];
    return {
      id: order.id,
      status: order.status,
      totalMinor: order.total_minor,
      currency: order.currency,
      discountMinor: order.discount_minor,
      taxMinor: order.tax_minor,
      quantity: order.quantity,
      expiresAt: order.expires_at,
      snapshot: order.snapshot,
      createdAt: order.created_at,
      disputeOpen: order.dispute_open,
      paymentRole: order.payment_role,
      groupId: group?.id ?? null,
      table: table ? tableProjection(table) : null,
      lines: (
        await this.db.query(
          'SELECT id,product_id AS "productId",quantity,total_minor AS "totalMinor",snapshot FROM order_lines WHERE order_id=$1 ORDER BY id',
          [order.id],
        )
      ).rows,
      tickets: (
        await this.db.query(
          'SELECT id,status,admitted_at AS "admittedAt",drinks_total AS "drinksTotal",drinks_used AS "drinksUsed",owner_id AS "ownerId" FROM tickets WHERE order_id=$1 ORDER BY id',
          [order.id],
        )
      ).rows,
      refunds: (
        await this.db.query(
          'SELECT id,status,amount_minor AS "amountMinor",reason FROM refunds WHERE order_id=$1 ORDER BY created_at',
          [order.id],
        )
      ).rows,
    };
  }
  async list(actor: Principal, before?: string) {
    const date = before ? z.iso.datetime({ offset: true }).parse(before) : new Date().toISOString();
    return {
      data: (
        await this.db.query(
          'SELECT id,status,total_minor AS "totalMinor",currency,snapshot,created_at AS "createdAt" FROM orders WHERE user_id=$1 AND created_at<$2 ORDER BY created_at DESC,id LIMIT 50',
          [actor.userId, date],
        )
      ).rows,
    };
  }
  async claim(actor: Principal, id: string) {
    this.organizations.verified(actor);
    return this.db.transaction(async (tx) => {
      const order = await this.lock(tx, id);
      const old = (await tx.query('SELECT kind FROM users WHERE id=$1', [order.user_id])).rows[0];
      if (
        order.buyer_email_hash !== hash(actor.email ?? '') ||
        (old.kind !== 'guest' && order.user_id !== actor.userId)
      )
        throw new ApiError('NOT_FOUND', 'Claimable guest order not found.', 404);
      const oldId = order.user_id;
      await tx.query('UPDATE orders SET user_id=$1 WHERE id=$2', [actor.userId, id]);
      await tx.query('UPDATE tickets SET owner_id=$1 WHERE order_id=$2 AND owner_id=$3', [
        actor.userId,
        id,
        oldId,
      ]);
      await audit(
        tx,
        actor.userId,
        'order.claim',
        'order',
        id,
        'Verified email holder claimed guest booking',
      );
      return { data: { claimed: true } };
    });
  }
  async startPayment(
    actor: Principal,
    id: string,
    acceptTerms = false,
    options?: { useSavedMethods?: boolean; saveCard?: boolean },
  ) {
    if (options?.saveCard && !options.useSavedMethods)
      throw new ApiError(
        'SAVED_METHODS_REQUIRED',
        'Enable saved payment methods before saving this card.',
        400,
      );
    const customerId = options?.useSavedMethods ? await this.savedMethods.forOrder(actor, id) : null;
    const attempt = await this.db.transaction(async (tx) => {
      const order = await this.lock(tx, id);
      this.owner(actor, order);
      await assertContributionPayable(tx, order);
      if (!acceptTerms && !order.buyer_accepted_at)
        throw new ApiError(
          'TERMS_REQUIRED',
          'Accept the booking terms and admission conditions before payment.',
          400,
        );
      if (!['held', 'payment-pending'].includes(order.status) || order.cancellation_requested)
        throw new ApiError('ORDER_NOT_PAYABLE', 'This order cannot start or resume payment.', 409);
      if (order.expires_at.getTime() <= Date.now())
        throw new ApiError('HOLD_EXPIRED', 'The checkout hold expired.', 409);
      const active = await tx.query("SELECT id FROM occurrences WHERE id=$1 AND status='published'", [
        order.occurrence_id,
      ]);
      if (!active.rowCount)
        throw new ApiError('EVENT_CHANGED', 'This occurrence no longer accepts payment.', 409);
      await tx.query('UPDATE orders SET buyer_accepted_at=coalesce(buyer_accepted_at,now()) WHERE id=$1', [
        id,
      ]);
      if (order.total_minor === 0) {
        await this.fulfill(tx, order);
        return null;
      }
      const prior = (await tx.query('SELECT * FROM payment_attempts WHERE order_id=$1', [id])).rows[0];
      if (
        prior &&
        options?.useSavedMethods !== undefined &&
        (Boolean(prior.customer_id) !== options.useSavedMethods ||
          prior.save_card !== Boolean(options.saveCard))
      )
        throw new ApiError(
          'PAYMENT_OPTIONS_LOCKED',
          'Payment options are fixed for this checkout. Resume the current payment or cancel it and create a new booking.',
          409,
        );
      const inserted = await tx.query(
        "INSERT INTO payment_attempts(id,order_id,account_id,customer_id,save_card,card_consent_at,card_save_status) VALUES($1,$2,$3,$4,$5,CASE WHEN $5 THEN now() ELSE NULL END,CASE WHEN $5 THEN 'pending' ELSE 'not-requested' END) ON CONFLICT(order_id) DO NOTHING RETURNING id",
        [randomUUID(), id, order.account_id, customerId, Boolean(options?.saveCard)],
      );
      if (inserted.rowCount && options?.saveCard)
        await audit(
          tx,
          actor.userId,
          'payment-method.consent',
          'payment-attempt',
          inserted.rows[0].id,
          'Customer opted to save this card with this seller for future on-session checkout',
          { consentVersion: 1, accountId: order.account_id, channel: actor.channel },
        );
      await tx.query("UPDATE orders SET status='payment-pending',updated_at=now() WHERE id=$1", [id]);
      const row = (await tx.query('SELECT id FROM payment_attempts WHERE order_id=$1', [id])).rows[0];
      await enqueue(tx, 'payment.prepare', row.id, { attemptId: row.id });
      return row.id as string;
    });
    if (attempt) await this.prepare(attempt);
    const row = (
      await this.db.query(
        'SELECT a.*,o.user_id,o.cancellation_requested,o.status AS order_status FROM payment_attempts a JOIN orders o ON o.id=a.order_id WHERE o.id=$1',
        [id],
      )
    ).rows[0];
    if (!row) return { data: { status: 'paid', orderId: id } };
    this.owner(actor, row);
    if (row.cancellation_requested || row.order_status !== 'payment-pending')
      return { data: { status: row.order_status, orderId: id } };
    return {
      data: {
        status: row.status,
        orderId: id,
        paymentIntentId: row.provider_id,
        clientSecret: row.client_secret_encrypted
          ? decrypt(row.client_secret_encrypted, this.db.config.encryptionKeys)
          : null,
        accountId: row.account_id,
        publishableKey: this.db.config.STRIPE_PUBLISHABLE_KEY,
        customerId: row.customer_id ?? undefined,
        customerSessionClientSecret: row.customer_id
          ? await this.provider.customerSession(row.account_id, row.customer_id, actor.channel)
          : undefined,
        savedMethodsEnabled: Boolean(row.customer_id),
        saveCard: row.save_card,
      },
    };
  }
  async prepare(attemptId: string) {
    const row = (
      await this.db.query(
        'SELECT a.*,o.total_minor,o.commission_minor,o.currency,o.status AS order_status FROM payment_attempts a JOIN orders o ON o.id=a.order_id WHERE a.id=$1',
        [attemptId],
      )
    ).rows[0];
    if (!row || row.provider_id || row.order_status !== 'payment-pending') return;
    if (Date.now() - row.created_at.getTime() > 23 * 3600_000) {
      await this.db.query("UPDATE orders SET status='review' WHERE id=$1 AND status='payment-pending'", [
        row.order_id,
      ]);
      throw new Error('Payment creation requires reconciliation beyond provider idempotency window.');
    }
    const value = await this.provider.createPayment(
      {
        orderId: row.order_id,
        attemptId: row.id,
        account: row.account_id,
        amount: row.total_minor,
        commission: row.commission_minor,
        currency: row.currency,
        customerId: row.customer_id,
        saveCard: row.save_card,
      },
      `payment-${row.id}`,
    );
    await this.applyPayment(row.account_id, value);
  }
  async applyPayment(account: string, payment: Payment) {
    if (
      !z.string().uuid().safeParse(payment.attemptId).success ||
      !z.string().uuid().safeParse(payment.orderId).success
    )
      return;
    return this.db.transaction(async (tx) => {
      const located = (
        await tx.query('SELECT order_id FROM payment_attempts WHERE id=$1 AND account_id=$2', [
          payment.attemptId,
          account,
        ])
      ).rows[0];
      if (!located) return;
      const order = await this.lock(tx, located.order_id);
      const attempt = (await tx.query('SELECT * FROM payment_attempts WHERE id=$1', [payment.attemptId]))
        .rows[0]!;
      if (
        payment.orderId !== order.id ||
        payment.amount !== order.total_minor ||
        payment.currency !== order.currency ||
        payment.commission !== order.commission_minor ||
        payment.livemode !== (this.db.config.STRIPE_MODE === 'live') ||
        (payment.customerId ?? null) !== attempt.customer_id ||
        (attempt.provider_id && attempt.provider_id !== payment.id)
      )
        throw new Error('Provider payment does not match the immutable order.');
      // A terminal local success cannot be reverted by a late failure/creation callback.
      if (attempt.status === 'succeeded' && payment.status !== 'succeeded') return;
      await tx.query(
        'UPDATE payment_attempts SET provider_id=$1,status=$2,client_secret_encrypted=$3,checked_at=now() WHERE id=$4',
        [
          payment.id,
          payment.status,
          payment.clientSecret ? encrypt(payment.clientSecret, this.db.config.encryptionKeys) : null,
          attempt.id,
        ],
      );
      if (payment.status === 'succeeded') {
        if (payment.received !== order.total_minor)
          throw new Error('Provider captured amount does not match order.');
        if (order.status === 'cancelled') {
          await tx.query("UPDATE orders SET status='review' WHERE id=$1", [order.id]);
          await enqueue(tx, 'payment.compensate', order.id, { orderId: order.id });
          return;
        }
        await this.fulfill(tx, order);
        if (Boolean(payment.saveForFuture) !== attempt.save_card) {
          // Saving preferences are separate from money. A captured, matching payment still fulfils its booking.
          const changed = await tx.query(
            "UPDATE payment_attempts SET card_save_status='review' WHERE id=$1 AND card_save_status<>'review' RETURNING id",
            [attempt.id],
          );
          if (changed.rowCount)
            await audit(
              tx,
              null,
              'payment-method.review',
              'payment-attempt',
              attempt.id,
              'Provider saving configuration differs from recorded consent; card redisplay withheld',
            );
        } else if (attempt.save_card)
          await enqueue(tx, 'card.redisplay', attempt.id, { attemptId: attempt.id });
        const occurrence = (
          await tx.query('SELECT status FROM occurrences WHERE id=$1', [order.occurrence_id])
        ).rows[0];
        if (order.cancellation_requested || occurrence.status === 'cancelled')
          await enqueue(tx, 'payment.compensate', order.id, { orderId: order.id });
      } else if (
        payment.status === 'canceled' &&
        ['held', 'payment-pending', 'review'].includes(order.status)
      )
        await this.release(tx, order.id);
    });
  }
  async fulfill(tx: PoolClient, order: any) {
    if (order.paid_at) return; // Never overwrite later financial review/refund states on replay of the original success.
    if (['paid', 'partially-refunded', 'refund-pending', 'refunded'].includes(order.status)) return;
    if (!['held', 'payment-pending', 'review'].includes(order.status))
      throw new Error('Cannot fulfill a released order.');
    if (
      order.payment_role === 'group-reservation' &&
      !(await tx.query("SELECT id FROM booking_groups WHERE order_id=$1 AND state='confirmed'", [order.id]))
        .rowCount
    )
      throw new Error('A group must be authoritatively funded before fulfillment.');
    const lines = (await tx.query('SELECT * FROM order_lines WHERE order_id=$1 ORDER BY id', [order.id]))
      .rows;
    for (const line of lines)
      for (let i = 0; i < line.admission_count; i++) {
        const credential = secret();
        await tx.query(
          'INSERT INTO tickets(id,order_id,line_id,occurrence_id,owner_id,ordinal,credential_hash,credential_encrypted,amount_minor,commission_minor,drinks_total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(line_id,ordinal) DO NOTHING',
          [
            randomUUID(),
            order.id,
            line.id,
            order.occurrence_id,
            order.user_id,
            i,
            hash(credential),
            encrypt(credential, this.db.config.encryptionKeys),
            distribute(line.total_minor, line.admission_count, i),
            distribute(line.commission_minor, line.admission_count, i),
            line.snapshot.drinks,
          ],
        );
      }
    await tx.query(
      "UPDATE orders SET status='paid',paid_at=coalesce(paid_at,clock_timestamp()),updated_at=now() WHERE id=$1",
      [order.id],
    );
    await tx.query("UPDATE inventory_reservations SET status='sold' WHERE order_id=$1", [order.id]);
    await tx.query("UPDATE promotion_uses SET status='used' WHERE order_id=$1", [order.id]);
    const table = (
      await tx.query(
        "UPDATE table_reservations SET status='confirmed' WHERE order_id=$1 AND status='held' RETURNING id,full_price_minor,online_amount_minor",
        [order.id],
      )
    ).rows[0];
    if (table) {
      await tx.query(
        "UPDATE table_allocations SET status='confirmed' WHERE reservation_id=$1 AND status='held'",
        [table.id],
      );
      const due = table.full_price_minor - table.online_amount_minor;
      await journal(
        tx,
        `table-balance:${table.id}`,
        order.currency,
        order.id,
        'Contracted table balance due to seller',
        { 'seller-receivable': due, 'seller-table-remaining': -due },
      );
    }
    if (order.payment_role !== 'group-reservation')
      await journal(tx, `sale:${order.id}`, order.currency, order.id, 'Captured sale or group contribution', {
        'provider-collected': order.total_minor,
        'seller-gross': -(order.total_minor - order.commission_minor),
        'platform-commission': -order.commission_minor,
      });
    if (order.payment_role === 'group-contribution') {
      await groupMoneyChanged(tx, order.id, 'payment');
      await notifyBuyer(
        tx,
        this.db.config,
        order.user_id,
        decrypt(order.buyer_email_encrypted, this.db.config.encryptionKeys) as string,
        'group-contribution',
        'Your group contribution was received',
        `Contribution ${order.id}\nOpen your group to check funding progress. A contribution alone does not confirm the table.`,
        `contribution:${order.id}`,
        { kind: 'booking', id: order.id },
      );
      return;
    }
    await notifyBuyer(
      tx,
      this.db.config,
      order.user_id,
      decrypt(order.buyer_email_encrypted, this.db.config.encryptionKeys) as string,
      'booking-confirmed',
      'Your Clubby booking is confirmed',
      `Booking ${order.id}\n${order.snapshot.title}\n${order.snapshot.venueName}\nOpen Clubby to access each admission.${order.snapshot.table ? `\nTable ${order.snapshot.table.table.label}. Balance due to the venue before entry: ${order.snapshot.table.fullPriceMinor - order.snapshot.table.onlineAmountMinor} ${order.currency} minor units. Table time: ${order.snapshot.table.slotStartsAt}.` : ''}`,
      `booking-confirmed:${order.id}`,
      { kind: 'booking', id: order.id },
    );
  }
  async release(tx: PoolClient, id: string) {
    const group = (await tx.query('SELECT * FROM booking_groups WHERE order_id=$1', [id])).rows[0];
    if (group) {
      const requested = (await tx.query('SELECT cancellation_requested FROM orders WHERE id=$1', [id]))
        .rows[0].cancellation_requested;
      if (requested)
        await cancelGroup(tx, group, 'The group owner or event cancellation requested a refund.');
      else await enqueue(tx, 'group.reconcile', randomUUID(), { groupId: group.id });
      return;
    }
    await tx.query("UPDATE orders SET status='cancelled',updated_at=now() WHERE id=$1", [id]);
    await tx.query("UPDATE inventory_reservations SET status='released' WHERE order_id=$1", [id]);
    await tx.query("UPDATE promotion_uses SET status='released' WHERE order_id=$1", [id]);
    await tx.query("UPDATE table_reservations SET status='cancelled' WHERE order_id=$1 AND status='held'", [
      id,
    ]);
    await tx.query(
      "UPDATE table_allocations SET status='released' WHERE reservation_id IN (SELECT id FROM table_reservations WHERE order_id=$1)",
      [id],
    );
    await groupMoneyChanged(tx, id, 'payment-cancelled');
  }
  async cancel(actor: Principal, id: string) {
    await this.db.transaction(async (tx) => {
      const order = await this.lock(tx, id);
      this.owner(actor, order);
      if (order.status === 'cancelled') return;
      if (!['held', 'payment-pending'].includes(order.status))
        throw new ApiError('REFUND_REQUIRED', 'Paid bookings must use the refund workflow.', 409);
      await tx.query('UPDATE orders SET cancellation_requested=true WHERE id=$1', [id]);
      await enqueue(tx, 'payment.expire', id, { orderId: id });
    });
    return { data: { status: 'cancellation-requested' } };
  }
  async expire(id: string) {
    const action = await this.db.transaction(async (tx) => {
      const order = await this.lock(tx, id);
      if (
        !['held', 'payment-pending'].includes(order.status) ||
        (!order.cancellation_requested && order.expires_at.getTime() > Date.now())
      )
        return null;
      const attempt = (await tx.query('SELECT * FROM payment_attempts WHERE order_id=$1', [id])).rows[0];
      if (!attempt) {
        await this.release(tx, id);
        return null;
      }
      await tx.query('UPDATE orders SET cancellation_requested=true WHERE id=$1', [id]);
      return attempt;
    });
    if (!action) return;
    if (!action.provider_id) await this.prepare(action.id);
    const row = (await this.db.query('SELECT * FROM payment_attempts WHERE id=$1', [action.id])).rows[0];
    if (!row?.provider_id) throw new Error('Payment intent is not reconciled; inventory remains reserved.');
    let value = await this.provider.payment(row.account_id, row.provider_id);
    if (!['succeeded', 'canceled'].includes(value.status)) {
      try {
        value = await this.provider.cancelPayment(row.account_id, row.provider_id, `cancel-${row.id}`);
      } catch {
        value = await this.provider.payment(row.account_id, row.provider_id);
        if (!['succeeded', 'canceled'].includes(value.status))
          throw new Error('Payment cancellation is unresolved.');
      }
    }
    await this.applyPayment(row.account_id, value);
  }
}
