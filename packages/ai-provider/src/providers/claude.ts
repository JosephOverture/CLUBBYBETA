import { z } from 'zod';
import { firstJsonObject } from '../json';
import {
  changeClassificationSchema,
  estimateCost,
  eventExtractionSchema,
  venueExtractionSchema,
  verificationResultSchema,
  type AIProvider,
  type AIResult,
  type ChangeClassification,
  type ChangeInput,
  type EventExtraction,
  type ExtractionInput,
  type ModelPricing,
  type ProviderUsage,
  type VenueExtraction,
  type VerificationResult,
  type VerifyInput,
} from '../types';
import {
  CHANGE_SYSTEM,
  EVENT_SYSTEM,
  VENUE_SYSTEM,
  VERIFY_SYSTEM,
  changeUser,
  eventUser,
  venueUser,
  verifyUser,
} from './prompts';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface ClaudeProviderConfig {
  apiKey: string;
  model: string;
  pricing: ModelPricing;
  baseUrl?: string;
  maxTokens?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/**
 * Anthropic (Claude) provider. Uses the HTTP Messages API directly via fetch so
 * the package carries no vendor SDK dependency. The API key is supplied through
 * config (sourced from env/secret manager by the caller) and never hardcoded.
 */
export class ClaudeProvider implements AIProvider {
  readonly id = 'claude';
  readonly model: string;
  private readonly cfg: Required<Omit<ClaudeProviderConfig, 'baseUrl' | 'maxTokens'>> & {
    baseUrl: string;
    maxTokens: number;
  };

  constructor(config: ClaudeProviderConfig) {
    this.model = config.model;
    this.cfg = {
      apiKey: config.apiKey,
      model: config.model,
      pricing: config.pricing,
      baseUrl: config.baseUrl ?? 'https://api.anthropic.com',
      maxTokens: config.maxTokens ?? 2048,
      fetchImpl: config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
    };
  }

  private async call(system: string, user: string): Promise<{ text: string; usage: ProviderUsage }> {
    const res = await this.cfg.fetchImpl(`${this.cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: this.cfg.maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Claude request failed with status ${res.status}`);
    const data: unknown = JSON.parse(await res.text());
    const parsed = claudeResponseSchema.parse(data);
    const text = parsed.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
    return {
      text,
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
      },
    };
  }

  private async run<T>(system: string, user: string, schema: z.ZodType<T>): Promise<AIResult<T>> {
    const { text, usage } = await this.call(system, user);
    const value = schema.parse(JSON.parse(firstJsonObject(text)));
    return {
      value,
      provider: this.id,
      model: this.model,
      usage,
      cost: estimateCost(usage, this.cfg.pricing),
      raw: text,
    };
  }

  extractVenueData(input: ExtractionInput): Promise<AIResult<VenueExtraction>> {
    return this.run(VENUE_SYSTEM, venueUser(input), venueExtractionSchema);
  }
  extractEventData(input: ExtractionInput): Promise<AIResult<EventExtraction>> {
    return this.run(EVENT_SYSTEM, eventUser(input), eventExtractionSchema);
  }
  classifyChange(input: ChangeInput): Promise<AIResult<ChangeClassification>> {
    return this.run(CHANGE_SYSTEM, changeUser(input), changeClassificationSchema);
  }
  verifyCandidate(input: VerifyInput): Promise<AIResult<VerificationResult>> {
    return this.run(VERIFY_SYSTEM, verifyUser(input), verificationResultSchema);
  }
}

const claudeResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});
