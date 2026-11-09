import {
  DEFAULT_SOURCE_PRIORITY,
  type FetchContext,
  type FetchResult,
  type SourceAdapter,
  type SourceType,
} from './types';

/**
 * Registry of source adapters. Each source type can be enabled/disabled
 * independently so scraping can be turned off (and later swapped for official
 * feeds) without changing the rest of the ingestion system.
 */
export class SourceAdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly disabled = new Set<SourceType>();

  register(adapter: SourceAdapter, options: { enabled?: boolean } = {}): void {
    this.adapters.set(adapter.id, adapter);
    if (options.enabled === false) this.disabled.add(adapter.sourceType);
  }

  setEnabled(type: SourceType, enabled: boolean): void {
    if (enabled) this.disabled.delete(type);
    else this.disabled.add(type);
  }

  isEnabled(type: SourceType): boolean {
    return !this.disabled.has(type);
  }

  get(id: string): SourceAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Adapters for a type, only if that type is currently enabled. */
  forType(type: SourceType): SourceAdapter[] {
    if (!this.isEnabled(type)) return [];
    return [...this.adapters.values()].filter((a) => a.sourceType === type);
  }

  /** Enabled adapters ordered by the configured source priority (preferred first). */
  enabledByPriority(priority: Record<SourceType, number> = DEFAULT_SOURCE_PRIORITY): SourceAdapter[] {
    return [...this.adapters.values()]
      .filter((a) => this.isEnabled(a.sourceType))
      .sort((a, b) => (priority[a.sourceType] ?? 999) - (priority[b.sourceType] ?? 999));
  }
}

/**
 * Deterministic adapter for tests and offline fixture runs. Returns canned
 * content for known URLs; never touches the network.
 */
export class FixtureAdapter implements SourceAdapter {
  readonly id: string;
  readonly sourceType: SourceType;
  private readonly fixtures: Map<string, string>;

  constructor(options: {
    id: string;
    sourceType: SourceType;
    fixtures: Record<string, string>;
  }) {
    this.id = options.id;
    this.sourceType = options.sourceType;
    this.fixtures = new Map(Object.entries(options.fixtures));
  }

  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const body = this.fixtures.get(ctx.url);
    if (body === undefined) throw new Error(`No fixture registered for ${ctx.url}`);
    return {
      url: ctx.url,
      status: 200,
      fetchedAt: new Date(0).toISOString(),
      contentType: 'text/html',
      body,
    };
  }
}
