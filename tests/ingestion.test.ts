import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SOURCE_PRIORITY,
  FixtureAdapter,
  SourceAdapterRegistry,
  computeNextCheckAt,
  contentHash,
  hasChanged,
  shouldExtract,
  toSnapshot,
} from '@clubby/ingestion';

describe('content hashing / cheap change detection', () => {
  it('is stable and detects changes', () => {
    const a = contentHash('hello');
    expect(a).toBe(contentHash('hello'));
    expect(a).not.toBe(contentHash('hello!'));
    expect(shouldExtract(a, a)).toBe(false);
    expect(shouldExtract(a, contentHash('hello!'))).toBe(true);
    expect(shouldExtract(null, a)).toBe(true); // first sighting
  });
  it('builds a snapshot and compares by hash', () => {
    const snap = toSnapshot(
      { url: 'https://x', status: 200, fetchedAt: '2026-01-01T00:00:00Z', body: 'body' },
      'venue_website',
    );
    expect(snap.contentHash).toBe(contentHash('body'));
    expect(hasChanged(snap.contentHash, snap)).toBe(false);
    expect(hasChanged('deadbeef', snap)).toBe(true);
  });
});

describe('SourceAdapterRegistry', () => {
  it('enables/disables per source type and orders by priority', async () => {
    const reg = new SourceAdapterRegistry();
    reg.register(new FixtureAdapter({ id: 'api', sourceType: 'official_api', fixtures: {} }));
    reg.register(new FixtureAdapter({ id: 'scrape', sourceType: 'venue_website', fixtures: {} }));
    reg.register(new FixtureAdapter({ id: 'social', sourceType: 'official_social', fixtures: {} }));

    // Official API is preferred over website over social.
    expect(reg.enabledByPriority(DEFAULT_SOURCE_PRIORITY).map((a) => a.id)).toEqual([
      'api',
      'scrape',
      'social',
    ]);

    // Disabling scraping removes only that source type; the rest keep working.
    reg.setEnabled('venue_website', false);
    expect(reg.isEnabled('venue_website')).toBe(false);
    expect(reg.forType('venue_website')).toHaveLength(0);
    expect(reg.enabledByPriority().map((a) => a.id)).toEqual(['api', 'social']);
  });

  it('fixture adapter returns canned content and errors on unknown URLs', async () => {
    const adapter = new FixtureAdapter({
      id: 'f',
      sourceType: 'venue_event_page',
      fixtures: { 'https://venue/events': '<html>events</html>' },
    });
    const res = await adapter.fetch({ url: 'https://venue/events' });
    expect(res.body).toContain('events');
    await expect(adapter.fetch({ url: 'https://venue/missing' })).rejects.toThrow();
  });
});

describe('adaptive scheduler', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('uses the base interval when no event is near and there are no failures', () => {
    const next = computeNextCheckAt({ sourceType: 'venue_website', now, lastCheckedAt: now });
    // venue_website base = 24h
    expect(next.getTime() - now.getTime()).toBe(24 * 3_600_000);
  });

  it('checks more frequently as the event approaches', () => {
    const soon = new Date(now.getTime() + 12 * 3_600_000);
    const next = computeNextCheckAt({
      sourceType: 'venue_website',
      now,
      lastCheckedAt: now,
      nearestEventAt: soon,
    });
    expect(next.getTime() - now.getTime()).toBe(1 * 3_600_000); // clamped to 1h within 24h
  });

  it('backs off exponentially on consecutive failures', () => {
    const base = computeNextCheckAt({ sourceType: 'official_api', now, lastCheckedAt: now });
    const failed = computeNextCheckAt({
      sourceType: 'official_api',
      now,
      lastCheckedAt: now,
      consecutiveFailures: 3,
    });
    expect(failed.getTime() - now.getTime()).toBe((base.getTime() - now.getTime()) * 8);
  });

  it('never schedules in the past', () => {
    const past = new Date(now.getTime() - 100 * 3_600_000);
    const next = computeNextCheckAt({ sourceType: 'venue_website', now, lastCheckedAt: past });
    expect(next.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });
});
