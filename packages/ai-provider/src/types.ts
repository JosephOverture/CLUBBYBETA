import { z } from 'zod';

/**
 * Provider-agnostic AI layer for Clubby's live-data (System B) pipeline.
 *
 * The rest of the ingestion system depends only on these interfaces and schemas,
 * never on a concrete vendor. Concrete providers (Claude, OpenAI, a deterministic
 * Fake for tests, others later) implement {@link AIProvider}. Selection is
 * config-driven (see registry.ts): the cheapest reliable model handles routine
 * structured extraction; a stronger model is reserved for ambiguity/conflict
 * verification.
 *
 * Extraction schemas allow null for every uncertain field on purpose: the
 * pipeline must NEVER invent venue/event facts. Unknown => null.
 */

/** A task's operational priority. Routine work is throttled first when over budget. */
export type TaskPriority = 'routine' | 'critical';

/** Which capability tier a task needs, used to pick provider+model. */
export type TaskTier = 'extraction' | 'verification';

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Envelope returned by every provider call. `cost` is in the tracker's currency unit. */
export interface AIResult<T> {
  value: T;
  provider: string;
  model: string;
  usage: ProviderUsage;
  cost: number;
  /** Raw text the model returned, retained for provenance/debugging. */
  raw: string;
}

export interface ExtractionInput {
  /** Source URL the content came from (provenance). */
  sourceUrl: string;
  /** Source classification (provenance). */
  sourceType: string;
  /** The raw text/markup snapshot to extract from. */
  content: string;
  /** Optional locale/timezone hints; never used to invent missing data. */
  hints?: { timezone?: string; city?: string; country?: string };
}

export interface ChangeInput {
  previous: unknown;
  current: unknown;
}

export interface VerifyInput {
  claim: string;
  /** Candidate value under verification (e.g. "permanently_closed", price, date). */
  candidate: unknown;
  /** Supporting observations from one or more sources. */
  observations: Array<{ sourceUrl: string; sourceType: string; excerpt: string }>;
}

/**
 * Venue fields the extractor may fill. Every field is `.nullish()` (may be null
 * or absent): the model must never invent data, so unknown fields come back as
 * null or omitted. Downstream code treats both as "unknown".
 */
export const venueExtractionSchema = z.object({
  name: z.string().nullish(),
  description: z.string().nullish(),
  address: z.string().nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  category: z.string().nullish(),
  genres: z.array(z.string()).nullish(),
  minimumAge: z.number().int().min(0).max(99).nullish(),
  website: z.string().url().nullish(),
  instagram: z.string().nullish(),
  socials: z.record(z.string(), z.string()).nullish(),
  ticketProvider: z.string().nullish(),
  ticketUrl: z.string().url().nullish(),
  operationalStatus: z
    .enum(['active', 'temporarily_closed', 'permanently_closed', 'unknown'])
    .nullish(),
  openingHours: z.string().nullish(),
});
export type VenueExtraction = z.infer<typeof venueExtractionSchema>;

/** Event fields the extractor may fill. Every field is `.nullish()` — never invented. */
export const eventExtractionSchema = z.object({
  title: z.string().nullish(),
  description: z.string().nullish(),
  date: z.string().nullish(),
  startTime: z.string().nullish(),
  endTime: z.string().nullish(),
  doorTime: z.string().nullish(),
  artists: z.array(z.string()).nullish(),
  genres: z.array(z.string()).nullish(),
  minimumAge: z.number().int().min(0).max(99).nullish(),
  priceFrom: z.number().min(0).nullish(),
  currency: z.string().length(3).nullish(),
  ticketTiers: z
    .array(z.object({ name: z.string(), priceMinor: z.number().int().min(0).nullish() }))
    .nullish(),
  ticketProvider: z.string().nullish(),
  ticketUrl: z.string().url().nullish(),
  soldOut: z.boolean().nullish(),
  status: z
    .enum(['active', 'sold_out', 'cancelled', 'postponed', 'rescheduled', 'completed', 'uncertain'])
    .nullish(),
});
export type EventExtraction = z.infer<typeof eventExtractionSchema>;

export const changeClassificationSchema = z.object({
  changeType: z.enum([
    'none',
    'new',
    'removed',
    'date_changed',
    'time_changed',
    'lineup_changed',
    'price_changed',
    'ticket_changed',
    'sold_out',
    'cancelled',
    'postponed',
    'rescheduled',
    'venue_changed',
    'other',
  ]),
  changedFields: z.array(z.string()),
  severity: z.enum(['low', 'medium', 'high']),
});
export type ChangeClassification = z.infer<typeof changeClassificationSchema>;

export const verificationResultSchema = z.object({
  verdict: z.enum(['confirm', 'reject', 'uncertain']),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;

/**
 * The provider-agnostic contract. All methods are extraction/verification of
 * data only; providers have no repository, network-write, or credential powers
 * beyond calling their own model endpoint.
 */
export interface AIProvider {
  readonly id: string;
  readonly model: string;
  extractVenueData(input: ExtractionInput): Promise<AIResult<VenueExtraction>>;
  extractEventData(input: ExtractionInput): Promise<AIResult<EventExtraction>>;
  classifyChange(input: ChangeInput): Promise<AIResult<ChangeClassification>>;
  verifyCandidate(input: VerifyInput): Promise<AIResult<VerificationResult>>;
}

/** Per-model token pricing, expressed in the cost tracker's currency per 1M tokens. */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export function estimateCost(usage: ProviderUsage, pricing: ModelPricing): number {
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPer1M +
    (usage.outputTokens / 1_000_000) * pricing.outputPer1M
  );
}
