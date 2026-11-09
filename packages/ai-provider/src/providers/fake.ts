import {
  type AIProvider,
  type AIResult,
  type ChangeClassification,
  type ChangeInput,
  type EventExtraction,
  type ExtractionInput,
  type VenueExtraction,
  type VerificationResult,
  type VerifyInput,
} from '../types';

export interface FakeResponses {
  venue?: VenueExtraction;
  event?: EventExtraction;
  change?: ChangeClassification;
  verify?: VerificationResult;
}

/**
 * Deterministic provider for tests and offline fixture-based pipeline runs.
 * Makes no network calls, records every call, and returns preconfigured values.
 */
export class FakeProvider implements AIProvider {
  readonly id = 'fake';
  readonly model = 'fake-1';
  readonly calls: Array<{ method: string; input: unknown }> = [];

  constructor(private readonly responses: FakeResponses = {}) {}

  private wrap<T>(value: T): AIResult<T> {
    return {
      value,
      provider: this.id,
      model: this.model,
      usage: { inputTokens: 10, outputTokens: 10 },
      cost: 0,
      raw: JSON.stringify(value),
    };
  }

  async extractVenueData(input: ExtractionInput): Promise<AIResult<VenueExtraction>> {
    this.calls.push({ method: 'extractVenueData', input });
    return this.wrap(this.responses.venue ?? EMPTY_VENUE);
  }

  async extractEventData(input: ExtractionInput): Promise<AIResult<EventExtraction>> {
    this.calls.push({ method: 'extractEventData', input });
    return this.wrap(this.responses.event ?? EMPTY_EVENT);
  }

  async classifyChange(input: ChangeInput): Promise<AIResult<ChangeClassification>> {
    this.calls.push({ method: 'classifyChange', input });
    return this.wrap(
      this.responses.change ?? { changeType: 'none', changedFields: [], severity: 'low' },
    );
  }

  async verifyCandidate(input: VerifyInput): Promise<AIResult<VerificationResult>> {
    this.calls.push({ method: 'verifyCandidate', input });
    return this.wrap(
      this.responses.verify ?? { verdict: 'uncertain', confidence: 0, rationale: 'fake' },
    );
  }
}

const EMPTY_VENUE: VenueExtraction = {
  name: null,
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
  operationalStatus: null,
  openingHours: null,
};

const EMPTY_EVENT: EventExtraction = {
  title: null,
  description: null,
  date: null,
  startTime: null,
  endTime: null,
  doorTime: null,
  artists: null,
  genres: null,
  minimumAge: null,
  priceFrom: null,
  currency: null,
  ticketTiers: null,
  ticketProvider: null,
  ticketUrl: null,
  soldOut: null,
  status: null,
};
