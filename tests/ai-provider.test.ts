import { describe, it, expect } from 'vitest';
import {
  AIRegistry,
  BudgetExceededError,
  ClaudeProvider,
  CostTracker,
  FakeProvider,
  OpenAIProvider,
  firstJsonObject,
  type FetchLike,
} from '@clubby/ai-provider';

function captureFetch(body: string): { fetch: FetchLike; last: { url?: string; init?: unknown } } {
  const last: { url?: string; init?: unknown } = {};
  const fetch: FetchLike = async (url, init) => {
    last.url = url;
    last.init = init;
    return { ok: true, status: 200, text: async () => body };
  };
  return { fetch, last };
}

describe('firstJsonObject', () => {
  it('extracts a balanced JSON object from surrounding prose/fences', () => {
    expect(firstJsonObject('```json\n{"a":{"b":1}}\n``` trailing')).toBe('{"a":{"b":1}}');
    expect(() => firstJsonObject('no json here')).toThrow();
  });
});

describe('FakeProvider', () => {
  it('returns configured values and records calls', async () => {
    const fake = new FakeProvider({
      venue: {
        name: 'Club X',
        description: null,
        address: null,
        latitude: null,
        longitude: null,
        category: null,
        genres: null,
        minimumAge: null,
        website: null,
        instagram: null,
        socials: null,
        ticketProvider: null,
        ticketUrl: null,
        operationalStatus: 'active',
        openingHours: null,
      },
    });
    const r = await fake.extractVenueData({ sourceUrl: 'https://x', sourceType: 'manual', content: '' });
    expect(r.value.name).toBe('Club X');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe('extractVenueData');
  });
});

describe('ClaudeProvider', () => {
  it('calls the messages API, parses JSON, and prices usage', async () => {
    const body = JSON.stringify({
      content: [{ type: 'text', text: '{"name":"Club X","operationalStatus":"active"}' }],
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    const { fetch, last } = captureFetch(body);
    const provider = new ClaudeProvider({
      apiKey: 'secret-key',
      model: 'claude-3-5-haiku-latest',
      pricing: { inputPer1M: 0.8, outputPer1M: 4 },
      fetchImpl: fetch,
    });
    const r = await provider.extractVenueData({
      sourceUrl: 'https://x',
      sourceType: 'venue_website',
      content: 'anything',
    });
    expect(r.value.name).toBe('Club X');
    expect(r.value.operationalStatus).toBe('active');
    expect(r.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(r.cost).toBeCloseTo(4.8, 5);
    expect(last.url).toContain('/v1/messages');
    expect((last.init as { headers: Record<string, string> }).headers['x-api-key']).toBe('secret-key');
  });
});

describe('OpenAIProvider', () => {
  it('calls chat/completions with bearer auth and parses JSON', async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: '{"title":"Night","status":"active"}' } }],
      usage: { prompt_tokens: 500_000, completion_tokens: 0 },
    });
    const { fetch, last } = captureFetch(body);
    const provider = new OpenAIProvider({
      apiKey: 'oa-key',
      model: 'gpt-4.1-mini',
      pricing: { inputPer1M: 0.4, outputPer1M: 1.6 },
      fetchImpl: fetch,
    });
    const r = await provider.extractEventData({
      sourceUrl: 'https://x',
      sourceType: 'venue_event_page',
      content: 'anything',
    });
    expect(r.value.title).toBe('Night');
    expect(r.cost).toBeCloseTo(0.2, 5);
    expect(last.url).toContain('/v1/chat/completions');
    expect((last.init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer oa-key');
  });
});

describe('CostTracker budget throttling', () => {
  it('sheds routine work past the soft threshold but allows critical up to the ceiling', () => {
    const t = new CostTracker({ monthlyCeiling: 10, softThresholdRatio: 0.8 });
    expect(t.authorize('routine').allowed).toBe(true);
    t.record('m', 8); // 80% -> soft threshold reached
    expect(t.authorize('routine').allowed).toBe(false);
    expect(t.authorize('critical').allowed).toBe(true);
    t.record('m', 3); // over the hard ceiling
    expect(t.authorize('critical').allowed).toBe(false);
    expect(t.snapshot().total).toBeCloseTo(11, 5);
  });
});

describe('AIRegistry', () => {
  it('records cost and throttles routine extraction when the budget is exhausted', async () => {
    const body = JSON.stringify({
      content: [{ type: 'text', text: '{"name":"Club X"}' }],
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    });
    const { fetch } = captureFetch(body);
    const registry = new AIRegistry({
      extraction: { provider: 'claude', model: 'claude-3-5-haiku-latest' },
      verification: { provider: 'fake', model: 'fake-1' },
      credentials: { claude: { apiKey: 'k' } },
      pricing: { 'claude-3-5-haiku-latest': { inputPer1M: 6, outputPer1M: 0 } },
      budget: { monthlyCeiling: 5, softThresholdRatio: 0.8 },
      fetchImpl: fetch,
    });
    const first = await registry.extractVenue({ sourceUrl: 'https://x', sourceType: 'venue_website', content: 'c' });
    expect(first.value.name).toBe('Club X');
    expect(registry.tracker.snapshot().total).toBeCloseTo(6, 5); // over ceiling now
    await expect(
      registry.extractVenue({ sourceUrl: 'https://y', sourceType: 'venue_website', content: 'c' }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });
});
