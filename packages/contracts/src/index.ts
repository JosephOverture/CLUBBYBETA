import { z } from 'zod';
export { reportSchema, type Report } from './reporting';

export const apiVersion = 'v1' as const;
export const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const moneySchema = z.object({
  amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export const venueSchema = z.object({
  id: idSchema,
  name: z.string(),
  cityId: idSchema,
  description: z.string(),
  timezone: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  commercialMode: z.enum(['native', 'external']),
  externalUrl: z.string().url().nullable(),
  version: z.number().int().positive(),
  demo: z.boolean(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  tags: z.array(z.string()).optional(),
  minimumAge: z.number().optional(),
  address: z.string().optional(),
  heroMediaId: z.string().uuid().nullable().optional(),
  distanceKm: z.number().nullable().optional(),
  openNow: z.boolean().optional(),
  genres: z.array(z.string()).optional(),
  category: z.string().nullable().optional(),
  neighbourhood: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  tagline: z.string().nullable().optional(),
  pick: z.string().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  calendarUrl: z.string().url().nullable().optional(),
  coordinateAccuracy: z.string().nullable().optional(),
  verifiedAt: z.string().nullable().optional(),
  accessNote: z.string().nullable().optional(),
  linkType: z.string().nullable().optional(),
});
export const venueListSchema = z.object({
  data: z.array(venueSchema),
  meta: z.object({ nextCursor: z.string().nullable() }).optional(),
});
export const venueResponseSchema = z.object({ data: venueSchema });
export const bootstrapSchema = z.object({
  settings: z
    .object({ banner: z.string(), newSalesPaused: z.boolean(), version: z.number().int().positive() })
    .optional(),
  data: z.object({
    apiVersion: z.literal(apiVersion),
    environment: z.enum(['development', 'test', 'staging', 'production']),
    capabilities: z.object({
      catalogue: z.boolean(),
      nativeCheckout: z.boolean(),
      externalCheckout: z.boolean(),
    }),
  }),
});
export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }),
});
export type Venue = z.infer<typeof venueSchema>;
export type Bootstrap = z.infer<typeof bootstrapSchema>;
export const offerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  admissionConditions: z.string(),
  priceMinor: z.number().int().nonnegative(),
  taxBps: z.number().int(),
  drinks: z.number().int(),
  extraDrinkPriceMinor: z.number().int().nullable(),
  extraDrinkLimit: z.number().int(),
  currency: z.string(),
  available: z.number().int(),
  saleStartsAt: z.string(),
  saleEndsAt: z.string(),
});
export const floorTableSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  zoneId: z.string(),
  seats: z.number().int(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  rotation: z.number(),
  shape: z.enum(['circle', 'rectangle']),
});
export const tableSnapshotSchema = z.object({
  offerId: z.string().uuid(),
  offerVersion: z.number().int(),
  layoutId: z.string().uuid(),
  table: floorTableSchema,
  slotStartsAt: z.string(),
  slotEndsAt: z.string(),
  guests: z.number().int(),
  fullPriceMinor: z.number().int(),
  onlineAmountMinor: z.number().int(),
  inclusions: z.string(),
  minimumSpendMinor: z.number().int(),
  terms: z.string(),
  noShowAfterMinutes: z.number().int(),
  noShowPolicy: z.literal('retain-paid'),
});
export const tableReservationSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  status: z.string(),
  currency: z.string(),
  guests: z.number().int(),
  snapshot: tableSnapshotSchema,
  fullPriceMinor: z.number().int(),
  onlineAmountMinor: z.number().int(),
  doorCollectedMinor: z.number().int(),
  balanceDueMinor: z.number().int(),
  doorRefundDueMinor: z.number().int(),
});
export const tableAvailabilitySchema = z.object({
  data: z.object({
    layoutId: z.string().uuid(),
    currency: z.string(),
    timezone: z.string(),
    content: z.object({
      name: z.string(),
      zones: z.array(z.object({ id: z.string(), label: z.string() })),
      tables: z.array(floorTableSchema),
    }),
    offers: z.array(
      z.object({
        id: z.string().uuid(),
        tableId: z.string().uuid(),
        slotStartsAt: z.string(),
        slotEndsAt: z.string(),
        minGuests: z.number().int(),
        maxGuests: z.number().int(),
        fullPriceMinor: z.number().int(),
        depositMinor: z.number().int().nullable(),
        inclusions: z.string(),
        minimumSpendMinor: z.number().int(),
        terms: z.string(),
        version: z.number().int(),
        available: z.boolean(),
      }),
    ),
  }),
});
export const orderSnapshotSchema = z.object({
  title: z.string(),
  venueName: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  timezone: z.string(),
  terms: z.string(),
  policyVersion: z.number().int(),
  minimumAge: z.number().optional(),
  refundCutoffHours: z.number().int(),
  taxRegistration: z.string(),
  table: tableSnapshotSchema.optional(),
});
export const heldOrderSchema = z.object({
  data: z.object({
    id: z.string().uuid(),
    status: z.string(),
    expiresAt: z.string(),
    totalMinor: z.number().int(),
    commissionMinor: z.number().int(),
    discountMinor: z.number().int(),
    taxMinor: z.number().int(),
    currency: z.string(),
    quantity: z.number().int(),
    snapshot: orderSnapshotSchema,
  }),
});
export const orderSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  totalMinor: z.number().int(),
  currency: z.string(),
  snapshot: orderSnapshotSchema,
  createdAt: z.string(),
});
export const orderResponseSchema = z.object({
  data: orderSummarySchema.extend({
    quantity: z.number().int(),
    expiresAt: z.string(),
    discountMinor: z.number().int(),
    taxMinor: z.number().int(),
    disputeOpen: z.boolean(),
    paymentRole: z.enum(['purchase', 'group-reservation', 'group-contribution']),
    groupId: z.string().uuid().nullable(),
    table: tableReservationSchema.nullable(),
    lines: z.array(
      z.object({
        id: z.string(),
        productId: z.string(),
        quantity: z.number(),
        totalMinor: z.number(),
        snapshot: z.object({ name: z.string(), drinks: z.number(), admissionConditions: z.string() }),
      }),
    ),
    tickets: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        admittedAt: z.string().nullable(),
        drinksTotal: z.number(),
        drinksUsed: z.number(),
        ownerId: z.string(),
      }),
    ),
    refunds: z.array(
      z.object({ id: z.string(), status: z.string(), amountMinor: z.number(), reason: z.string() }),
    ),
  }),
});
export const paymentSessionSchema = z.object({
  data: z.object({
    orderId: z.string().uuid(),
    status: z.string(),
    paymentIntentId: z.string().nullable().optional(),
    clientSecret: z.string().nullable().optional(),
    accountId: z.string().optional(),
    publishableKey: z.string().optional(),
    customerId: z.string().optional(),
    customerSessionClientSecret: z.string().optional(),
    savedMethodsEnabled: z.boolean().optional(),
    saveCard: z.boolean().optional(),
  }),
});
export const ticketResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    orderId: z.string(),
    occurrenceId: z.string(),
    status: z.string(),
    admittedAt: z.string().nullable(),
    drinksTotal: z.number(),
    drinksUsed: z.number(),
    snapshot: orderSnapshotSchema,
    currentSchedule: z.object({ startsAt: z.string(), endsAt: z.string() }),
    credential: z.string().nullable(),
  }),
});
export type Offer = z.infer<typeof offerSchema>;
export type Order = z.infer<typeof orderResponseSchema>['data'];
export type PaymentSession = z.infer<typeof paymentSessionSchema>['data'];
export const groupResponseSchema = z.object({
  data: z.object({
    id: z.string().uuid(),
    name: z.string(),
    state: z.string(),
    ownerId: z.string().uuid(),
    ownerUnavailable: z.boolean().default(false),
    orderId: z.string().uuid().nullable(),
    reservationId: z.string().uuid(),
    targetMinor: z.number().int(),
    paidMinor: z.number().int(),
    reservedMinor: z.number().int(),
    remainingMinor: z.number().int(),
    currency: z.string(),
    deadline: z.string(),
    terms: z.string(),
    version: z.number().int(),
    snapshot: orderSnapshotSchema,
    disputeOpen: z.boolean(),
    balanceDueMinor: z.number().int(),
    contributions: z.array(
      z.object({
        id: z.string().uuid(),
        userId: z.string().uuid(),
        orderId: z.string().uuid().nullable(),
        displayName: z.string(),
        amountMinor: z.number().int(),
        status: z.string(),
        disputeOpen: z.boolean(),
        refundedMinor: z.number().int(),
      }),
    ),
    members: z.array(z.object({ id: z.string().uuid(), displayName: z.string(), status: z.string() })),
    tickets: z.array(z.object({ id: z.string().uuid(), status: z.string() })),
    ownershipOffers: z.array(
      z.object({
        id: z.string().uuid(),
        fromUserId: z.string().uuid(),
        toUserId: z.string().uuid(),
        expiresAt: z.string(),
      }),
    ),
  }),
});
export const groupMessageSchema = z.object({
  id: z.string().uuid(),
  sequence: z.string(),
  authorId: z.string().uuid(),
  displayName: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export const groupMessagesSchema = z.object({
  data: z.array(groupMessageSchema),
  meta: z.object({ nextCursor: z.string(), hasMore: z.boolean() }),
});
export const groupUpdatesSchema = z.object({
  data: z.array(
    z.object({
      sequence: z.string(),
      kind: z.string(),
      payload: z.record(z.string(), z.unknown()),
      createdAt: z.string(),
    }),
  ),
  meta: z.object({ nextCursor: z.string(), hasMore: z.boolean(), pollAfterMs: z.number() }),
});
export type BookingGroup = z.infer<typeof groupResponseSchema>['data'];
