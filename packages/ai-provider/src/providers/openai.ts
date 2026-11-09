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
import type { FetchLike } from './claude';

export interface OpenAIProviderConfig {
  apiKey: string;
  model: string;
  pricing: ModelPricing;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * OpenAI provider via the Chat Completions HTTP API (JSON mode). No SDK
 * dependency; key supplied through config, never hardcoded.
 */
export class OpenAIProvider implements AIProvider {
  readonly id = 'openai';
  readonly model: string;
  private readonly cfg: Required<Omit<OpenAIProviderConfig, 'baseUrl'>> & { baseUrl: string };

  constructor(config: OpenAIProviderConfig) {
    this.model = config.model;
    this.cfg = {
      apiKey: config.apiKey,
      model: config.model,
      pricing: config.pricing,
      baseUrl: config.baseUrl ?? 'https://api.openai.com',
      fetchImpl: config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
    };
  }

  private async call(system: string, user: string): Promise<{ text: string; usage: ProviderUsage }> {
    const res = await this.cfg.fetchImpl(`${this.cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI request failed with status ${res.status}`);
    const data: unknown = JSON.parse(await res.text());
    const parsed = openaiResponseSchema.parse(data);
    const text = parsed.choices[0]?.message?.content ?? '';
    return {
      text,
      usage: {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
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

const openaiResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }).optional() })),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
});
