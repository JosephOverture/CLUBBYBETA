import { BudgetExceededError, CostTracker, type CostTrackerOptions } from './cost';
import { ClaudeProvider, type FetchLike } from './providers/claude';
import { FakeProvider, type FakeResponses } from './providers/fake';
import { OpenAIProvider } from './providers/openai';
import type {
  AIProvider,
  AIResult,
  ChangeClassification,
  ChangeInput,
  EventExtraction,
  ExtractionInput,
  ModelPricing,
  TaskPriority,
  VenueExtraction,
  VerificationResult,
  VerifyInput,
} from './types';

export type ProviderId = 'claude' | 'openai' | 'fake';

export interface TierConfig {
  provider: ProviderId;
  model: string;
}

export interface AIConfig {
  /** Cheapest reliable model for routine structured extraction. */
  extraction: TierConfig;
  /** Stronger model reserved for ambiguity/conflict verification. */
  verification: TierConfig;
  budget?: CostTrackerOptions;
  credentials?: { claude?: { apiKey: string }; openai?: { apiKey: string } };
  /** Per-model pricing overrides (currency per 1M tokens). */
  pricing?: Record<string, ModelPricing>;
  /** Canned responses for the fake provider (offline/fixture mode). */
  fake?: FakeResponses;
  fetchImpl?: FetchLike;
}

/**
 * Conservative default pricing (currency units per 1M tokens). These are
 * ESTIMATES for budgeting only — override via config.pricing with live rates.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'claude-3-5-haiku-latest': { inputPer1M: 0.8, outputPer1M: 4 },
  'claude-sonnet-4-5': { inputPer1M: 3, outputPer1M: 15 },
  'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6 },
  'gpt-4.1': { inputPer1M: 2, outputPer1M: 8 },
  'fake-1': { inputPer1M: 0, outputPer1M: 0 },
};

const FALLBACK_PRICING: ModelPricing = { inputPer1M: 5, outputPer1M: 15 };

function pricingFor(model: string, overrides?: Record<string, ModelPricing>): ModelPricing {
  return overrides?.[model] ?? DEFAULT_PRICING[model] ?? FALLBACK_PRICING;
}

function buildProvider(tier: TierConfig, config: AIConfig): AIProvider {
  const pricing = pricingFor(tier.model, config.pricing);
  if (tier.provider === 'fake') return new FakeProvider(config.fake);
  if (tier.provider === 'claude') {
    const apiKey = config.credentials?.claude?.apiKey;
    if (!apiKey) throw new Error('Claude credentials are not configured.');
    return new ClaudeProvider({ apiKey, model: tier.model, pricing, ...fetchOpt(config) });
  }
  const apiKey = config.credentials?.openai?.apiKey;
  if (!apiKey) throw new Error('OpenAI credentials are not configured.');
  return new OpenAIProvider({ apiKey, model: tier.model, pricing, ...fetchOpt(config) });
}

function fetchOpt(config: AIConfig): { fetchImpl?: FetchLike } {
  return config.fetchImpl ? { fetchImpl: config.fetchImpl } : {};
}

/**
 * Budget-aware, provider-agnostic dispatcher. Callers use this, never a concrete
 * provider. Routine extraction is shed first when the budget tightens; critical
 * verification runs up to the hard ceiling.
 */
export class AIRegistry {
  readonly tracker: CostTracker;
  private readonly extraction: AIProvider;
  private readonly verification: AIProvider;

  constructor(config: AIConfig) {
    this.tracker = new CostTracker(config.budget);
    this.extraction = buildProvider(config.extraction, config);
    this.verification = buildProvider(config.verification, config);
  }

  private async dispatch<T>(
    provider: AIProvider,
    priority: TaskPriority,
    run: () => Promise<AIResult<T>>,
  ): Promise<AIResult<T>> {
    const decision = this.tracker.authorize(priority);
    if (!decision.allowed) throw new BudgetExceededError(decision.reason, decision.retryAfterPeriod);
    const result = await run();
    this.tracker.record(result.model, result.cost);
    return result;
  }

  extractVenue(input: ExtractionInput, priority: TaskPriority = 'routine') {
    return this.dispatch(this.extraction, priority, () => this.extraction.extractVenueData(input));
  }
  extractEvent(input: ExtractionInput, priority: TaskPriority = 'routine') {
    return this.dispatch(this.extraction, priority, () => this.extraction.extractEventData(input));
  }
  classifyChange(input: ChangeInput, priority: TaskPriority = 'routine') {
    return this.dispatch(this.extraction, priority, () => this.extraction.classifyChange(input));
  }
  verify(input: VerifyInput, priority: TaskPriority = 'critical') {
    return this.dispatch(this.verification, priority, () => this.verification.verifyCandidate(input));
  }
}

export type {
  AIResult,
  VenueExtraction,
  EventExtraction,
  ChangeClassification,
  VerificationResult,
};
