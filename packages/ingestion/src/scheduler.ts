import { DEFAULT_BASE_INTERVALS, type SourceType } from './types';

export interface ScheduleInput {
  sourceType: SourceType;
  /** When the source was last checked; defaults to now (first schedule). */
  lastCheckedAt?: Date | null;
  /** Consecutive failures so far; drives exponential backoff. */
  consecutiveFailures?: number;
  /** Soonest upcoming event for this source; nearer events => more frequent checks. */
  nearestEventAt?: Date | null;
  now?: Date;
  /** Per-type base interval overrides (ms). */
  baseIntervals?: Partial<Record<SourceType, number>>;
}

const HOUR = 3_600_000;
const MAX_INTERVAL = 14 * 24 * HOUR; // never wait longer than two weeks
const MAX_BACKOFF_STEPS = 6;

/**
 * Adaptive refresh scheduling:
 *  - base cadence per source type,
 *  - events nearer their date are checked more often (tightens the interval),
 *  - failing sources back off exponentially (capped),
 *  - the result never schedules in the past.
 * Pure function — fully unit-testable, no side effects.
 */
export function computeNextCheckAt(input: ScheduleInput): Date {
  const now = input.now ?? new Date();
  const base = input.baseIntervals?.[input.sourceType] ?? DEFAULT_BASE_INTERVALS[input.sourceType];

  let interval = base;

  // Event-proximity weighting: clamp the interval as the event approaches.
  const nearest = input.nearestEventAt ?? null;
  if (nearest) {
    const untilEvent = nearest.getTime() - now.getTime();
    if (untilEvent >= 0) {
      if (untilEvent <= 24 * HOUR) interval = Math.min(interval, 1 * HOUR);
      else if (untilEvent <= 72 * HOUR) interval = Math.min(interval, 6 * HOUR);
      else if (untilEvent <= 7 * 24 * HOUR) interval = Math.min(interval, 24 * HOUR);
    }
  }

  // Exponential backoff on consecutive failures.
  const failures = Math.max(0, input.consecutiveFailures ?? 0);
  if (failures > 0) {
    interval *= 2 ** Math.min(failures, MAX_BACKOFF_STEPS);
  }

  interval = Math.min(interval, MAX_INTERVAL);

  const anchor = input.lastCheckedAt ?? now;
  const next = new Date(anchor.getTime() + interval);
  return next.getTime() < now.getTime() ? now : next;
}
