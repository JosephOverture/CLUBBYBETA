import { Database } from '../platform/database';
import type { Principal } from '../identity/identity.service';
import { OrganizationsService, audit } from '../organizations/organizations.service';
import { ApiError } from '../platform/http';
import { OrdersService } from './orders.service';
import { notifyBuyer } from './core';
import { decrypt } from '../platform/crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
const escape = (value: unknown) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const cell = (value: unknown) => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  let text = String(value ?? '');
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
export class BillingService {
  constructor(
    readonly db: Database,
    readonly organizations: OrganizationsService,
    readonly orders: OrdersService,
  ) {}
  async receipt(actor: Principal, id: string) {
    const order = (
      await this.db.query(
        'SELECT o.*,org.name AS seller_name,org.application FROM orders o JOIN organizations org ON org.id=o.organization_id WHERE o.id=$1',
        [id],
      )
    ).rows[0];
    if (!order) throw new ApiError('NOT_FOUND', 'Receipt not found.', 404);
    this.orders.owner(actor, order);
    if (!order.paid_at)
      throw new ApiError('NOT_PAID', 'A receipt is available after confirmed payment.', 409);
    const lines = (
      await this.db.query(
        'SELECT quantity,total_minor,tax_minor,snapshot FROM order_lines WHERE order_id=$1 ORDER BY id',
        [id],
      )
    ).rows;
    const amounts = (amount: number) => `${(amount / 100).toFixed(2)} ${escape(order.currency)}`;
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Clubby booking receipt</title><body><main><h1>Booking receipt</h1><p>Reference: ${escape(order.id)}</p><p>Seller: ${escape(order.snapshot.sellerLegalName)}<br>Tax registration: ${escape(order.snapshot.taxRegistration)}</p><p>${escape(order.snapshot.title)} · ${escape(order.snapshot.venueName)}</p><p>Payment confirmed: ${escape(order.paid_at.toISOString())}</p><table><thead><tr><th>Description</th><th>Quantity</th><th>Total</th><th>Included tax</th></tr></thead><tbody>${lines.map((line) => `<tr><td>${escape(line.snapshot.name)}</td><td>${line.quantity}</td><td>${amounts(line.total_minor)}</td><td>${amounts(line.tax_minor)}</td></tr>`).join('')}</tbody></table><p>Paid total: ${amounts(order.total_minor)}</p><p>Booking status: ${escape(order.status)}</p><p>For a fiscal invoice, contact the seller using booking support.</p></main></body></html>`;
  }
  async statement(actor: Principal, organizationId: string, raw: unknown) {
    const input = z
      .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
      .strict()
      .parse(raw);
    if (
      Date.parse(input.to) <= Date.parse(input.from) ||
      Date.parse(input.to) - Date.parse(input.from) > 366 * 24 * 3600_000
    )
      throw new ApiError('INVALID_INTERVAL', 'Choose a reporting interval of at most one year.', 400);
    await this.organizations.authorize(actor, organizationId, 'finance.read');
    const rows = (
      await this.db.query(
        `SELECT j.created_at,j.reference,j.currency,j.order_id,p.account,p.amount_minor FROM ledger_journals j JOIN ledger_postings p ON p.journal_id=j.id JOIN orders o ON o.id=j.order_id WHERE o.organization_id=$1 AND j.created_at>=$2 AND j.created_at<$3 ORDER BY j.created_at,j.id,p.id LIMIT 100001`,
        [organizationId, input.from, input.to],
      )
    ).rows;
    if (rows.length > 100000)
      throw new ApiError('EXPORT_TOO_LARGE', 'Choose a narrower statement interval.', 400);
    await this.db.transaction((tx) =>
      audit(
        tx,
        actor.userId,
        'finance.export',
        'organization',
        organizationId,
        'Seller exported accounting statement',
        input,
      ),
    );
    return [
      'created_at,reference,currency,order_id,account,amount_minor',
      ...rows.map((row) =>
        [
          row.created_at.toISOString(),
          row.reference,
          row.currency,
          row.order_id,
          row.account,
          Number(row.amount_minor),
        ]
          .map(cell)
          .join(','),
      ),
    ].join('\r\n');
  }
  async resend(actor: Principal, id: string, reason: string) {
    return this.db.transaction(async (tx) => {
      const order = await this.orders.lock(tx, id);
      await this.organizations.authorize(
        actor,
        order.organization_id,
        'booking.read',
        order.venue_id,
        false,
        tx,
      );
      if (!order.paid_at) throw new ApiError('NOT_PAID', 'Only confirmed bookings can be resent.', 409);
      const recent = (
        await tx.query(
          "SELECT id FROM audit_events WHERE action='booking.resend' AND resource_id=$1 AND created_at>now()-interval '5 minutes'",
          [id],
        )
      ).rowCount;
      if (recent)
        throw new ApiError(
          'RESEND_LIMIT',
          'A confirmation was recently resent. Please wait five minutes.',
          429,
        );
      await notifyBuyer(
        tx,
        this.db.config,
        order.user_id,
        decrypt(order.buyer_email_encrypted, this.db.config.encryptionKeys) as string,
        'booking-resend',
        'Your Clubby booking',
        `Booking ${order.id}\n${order.snapshot.title}\nOpen your bookings in Clubby to view current admission credentials.`,
        `booking-resend:${randomUUID()}`,
        { kind: 'booking', id: order.id },
      );
      await audit(
        tx,
        actor.userId,
        'booking.resend',
        'order',
        id,
        z.string().min(10).max(1000).parse(reason),
      );
      return { data: { queued: true } };
    });
  }
}
