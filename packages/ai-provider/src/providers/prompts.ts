import type { ChangeInput, ExtractionInput, VerifyInput } from '../types';

/**
 * Shared prompts so every provider extracts identically. The overriding rule in
 * all of them: NEVER invent data. If a field is not clearly supported by the
 * supplied content, return null. This mirrors the database's unknown=null policy.
 */
const NO_INVENT =
  'Return ONLY a single JSON object. For any field not explicitly and reliably ' +
  'supported by the supplied content, use null. Never guess, infer, or fabricate ' +
  'values, dates, prices, ages, or links. No prose, no markdown fences.';

export const VENUE_SYSTEM = `You extract factual nightlife VENUE metadata from one source document. ${NO_INVENT}`;
export const EVENT_SYSTEM = `You extract UPCOMING nightlife EVENT data from one source document. ${NO_INVENT}`;
export const CHANGE_SYSTEM = `You compare a previously stored record with a newly extracted record and classify what changed. ${NO_INVENT}`;
export const VERIFY_SYSTEM = `You judge whether a specific candidate claim is supported by the supplied observations. ${NO_INVENT}`;

export function venueUser(input: ExtractionInput): string {
  return `Source URL: ${input.sourceUrl}\nSource type: ${input.sourceType}\nHints: ${JSON.stringify(input.hints ?? {})}\n\nContent:\n${input.content}`;
}

export function eventUser(input: ExtractionInput): string {
  return `Source URL: ${input.sourceUrl}\nSource type: ${input.sourceType}\nHints: ${JSON.stringify(input.hints ?? {})}\nExtract only future-dated events.\n\nContent:\n${input.content}`;
}

export function changeUser(input: ChangeInput): string {
  return `PREVIOUS:\n${JSON.stringify(input.previous)}\n\nCURRENT:\n${JSON.stringify(input.current)}`;
}

export function verifyUser(input: VerifyInput): string {
  return `Claim: ${input.claim}\nCandidate: ${JSON.stringify(input.candidate)}\n\nObservations:\n${JSON.stringify(input.observations, null, 2)}`;
}
