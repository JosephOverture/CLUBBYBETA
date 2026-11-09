import { createHash } from 'node:crypto';
import type { FetchResult, SourceType } from './types';

/** Stable SHA-256 hex hash of raw source content (the cheap change-detection key). */
export function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export interface RawSnapshot {
  sourceUrl: string;
  sourceType: SourceType;
  fetchedAt: string;
  contentHash: string;
  body: string;
}

export function toSnapshot(result: FetchResult, sourceType: SourceType): RawSnapshot {
  return {
    sourceUrl: result.url,
    sourceType,
    fetchedAt: result.fetchedAt,
    contentHash: contentHash(result.body),
    body: result.body,
  };
}

/**
 * Cheap change-detection gate: extraction (and any AI call) should run only when
 * the content hash differs from the last stored snapshot. Unknown previous hash
 * counts as changed (first sighting).
 */
export function shouldExtract(previousHash: string | null | undefined, nextHash: string): boolean {
  return previousHash !== nextHash;
}

export function hasChanged(
  previousHash: string | null | undefined,
  next: RawSnapshot | string,
): boolean {
  const nextHash = typeof next === 'string' ? next : next.contentHash;
  return shouldExtract(previousHash, nextHash);
}
