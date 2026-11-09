import { z } from 'zod';
const integer = z.string().regex(/^-?[0-9]+$/),
  count = z.string().regex(/^[0-9]+$/),
  currency = z.string().regex(/^[A-Z]{3}$/);
const instant = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((value) => (typeof value === 'string' ? value : value.toISOString()));
export const reportSchema = z.object({
  version: z.literal(1),
  generatedAt: instant,
  filters: z.object({
    from: z.string(),
    to: z.string(),
    timezone: z.string(),
    venueId: z.string().optional(),
    occurrenceId: z.string().optional(),
    currency: currency.optional(),
  }),
  financial: z.array(
    z.object({
      currency,
      day: z.string(),
      grossMinor: integer,
      refundMinor: integer,
      commissionMinor: integer,
      chargebackLossMinor: integer,
      netOnlineMinor: integer,
      sellerNetBeforeProviderFeesMinor: integer,
      doorCollectedMinor: integer,
      receivableMovementMinor: integer,
    }),
  ),
  cohort: z.array(
    z.object({ currency, checkoutsStarted: count, checkoutsPaid: count, buyers: count, repeatBuyers: count }),
  ),
  admissions: z.object({ admissions: count, drinks: count, rejectedScans: count }),
  events: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      venueId: z.string(),
      startsAt: instant,
      timezone: z.string(),
      currency,
      status: z.string(),
      capacity: z.number().int().nonnegative(),
      activeAdmissions: count,
      admitted: count,
      confirmedTables: count,
      noShowTables: count,
    }),
  ),
  reconciliation: z.array(
    z.object({
      currency,
      captureDifferenceMinor: integer,
      refundDifferenceMinor: integer,
      unallocatedProviderRefunds: count,
      ordersUnderReview: count,
      currentTableReceivableMinor: integer,
    }),
  ),
  provider: z
    .object({
      activity: z.array(z.object({ currency, amountMinor: integer, feeMinor: integer, netMinor: integer })),
      freshness: z.array(
        z.object({
          organizationId: z.string(),
          lastMatchedAt: instant.nullable(),
          lastAttemptAt: instant.nullable(),
          latestStatus: z.string().nullable(),
        }),
      ),
      payouts: z.array(z.object({ currency, status: z.string(), count, amountMinor: integer })),
    })
    .nullable(),
});
export type Report = z.infer<typeof reportSchema>;
