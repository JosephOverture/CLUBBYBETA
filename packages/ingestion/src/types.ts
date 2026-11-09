/**
 * Shared types for Clubby's live-data (System B) ingestion pipeline.
 *
 * The source layer is deliberately typed so scraping can later be replaced by
 * official feeds/APIs without touching the rest of the pipeline: each source has
 * a `SourceType` and an `acquisition` method, and adapters are enabled/disabled
 * per type at runtime.
 */

export type SourceType =
  | 'official_api'
  | 'partner_feed'
  | 'venue_website'
  | 'venue_event_page'
  | 'ticketing_provider'
  | 'official_social'
  | 'promoter'
  | 'manual';

/** How data is acquired — governs the legal/ToS posture (scrape only where permitted). */
export type Acquisition = 'api' | 'feed' | 'scrape' | 'manual';

export const ACQUISITION_BY_TYPE: Record<SourceType, Acquisition> = {
  official_api: 'api',
  partner_feed: 'feed',
  venue_website: 'scrape',
  venue_event_page: 'scrape',
  ticketing_provider: 'api',
  official_social: 'scrape',
  promoter: 'scrape',
  manual: 'manual',
};

/**
 * Default source priority (lower = preferred), encoding the approved sourcing
 * order: first-party/official APIs & partner feeds first, official
 * websites/event pages second, ticketing third, social fourth, promoter last;
 * manually curated sources are trusted highly.
 */
export const DEFAULT_SOURCE_PRIORITY: Record<SourceType, number> = {
  manual: 5,
  official_api: 10,
  partner_feed: 10,
  venue_website: 20,
  venue_event_page: 20,
  ticketing_provider: 30,
  official_social: 40,
  promoter: 50,
};

/** Default refresh cadence per source type, in milliseconds. Overridable. */
export const DEFAULT_BASE_INTERVALS: Record<SourceType, number> = {
  official_api: 6 * 3_600_000,
  partner_feed: 6 * 3_600_000,
  venue_event_page: 6 * 3_600_000,
  ticketing_provider: 6 * 3_600_000,
  venue_website: 24 * 3_600_000,
  official_social: 12 * 3_600_000,
  promoter: 24 * 3_600_000,
  manual: 7 * 24 * 3_600_000,
};

export interface FetchContext {
  url: string;
  /** Previous content hash, so adapters that support conditional fetch can skip. */
  lastContentHash?: string | null;
  etag?: string | null;
}

export interface FetchResult {
  url: string;
  status: number;
  fetchedAt: string;
  contentType?: string;
  body: string;
}

/** A source adapter fetches raw content for one source type. No parsing/AI here. */
export interface SourceAdapter {
  readonly id: string;
  readonly sourceType: SourceType;
  fetch(ctx: FetchContext): Promise<FetchResult>;
}
