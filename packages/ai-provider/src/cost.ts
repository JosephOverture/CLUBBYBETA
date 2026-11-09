import type { TaskPriority } from './types';

/**
 * Tracks AI spend per provider/model and enforces a monthly budget ceiling with
 * graceful degradation: when spend crosses the soft threshold, ROUTINE work is
 * paused/slowed while CRITICAL work (e.g. verifying a cancellation or closure)
 * still runs, up to the hard ceiling. This keeps core ingestion alive and only
 * sheds non-essential enrichment when the budget is tight.
 *
 * Amounts are unit-agnostic numbers in the configured currency (default EUR).
 */
export interface CostTrackerOptions {
  /** Hard monthly ceiling. Default 300 (EUR) per the approved dev/testing budget. */
  monthlyCeiling?: number;
  /** Fraction of the ceiling at which routine work starts to be throttled. */
  softThresholdRatio?: number;
  currency?: string;
  /** Returns the current YYYY-MM period key; injectable for tests. */
  now?: () => Date;
}

export interface SpendSnapshot {
  period: string;
  currency: string;
  total: number;
  ceiling: number;
  softThreshold: number;
  byModel: Record<string, number>;
}

export type BudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: 'ceiling_exceeded' | 'soft_throttled'; retryAfterPeriod: string };

function periodKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export class CostTracker {
  private readonly ceiling: number;
  private readonly softRatio: number;
  private readonly currency: string;
  private readonly now: () => Date;
  private period: string;
  private total = 0;
  private byModel: Record<string, number> = {};

  constructor(options: CostTrackerOptions = {}) {
    this.ceiling = options.monthlyCeiling ?? 300;
    this.softRatio = options.softThresholdRatio ?? 0.8;
    this.currency = options.currency ?? 'EUR';
    this.now = options.now ?? (() => new Date());
    this.period = periodKey(this.now());
  }

  private rollIfNewPeriod(): void {
    const current = periodKey(this.now());
    if (current !== this.period) {
      this.period = current;
      this.total = 0;
      this.byModel = {};
    }
  }

  /**
   * Decide whether a task may run BEFORE spending. Critical tasks are allowed up
   * to the hard ceiling; routine tasks are shed once past the soft threshold.
   */
  authorize(priority: TaskPriority): BudgetDecision {
    this.rollIfNewPeriod();
    if (this.total >= this.ceiling) {
      return { allowed: false, reason: 'ceiling_exceeded', retryAfterPeriod: this.nextPeriod() };
    }
    if (priority === 'routine' && this.total >= this.ceiling * this.softRatio) {
      return { allowed: false, reason: 'soft_throttled', retryAfterPeriod: this.nextPeriod() };
    }
    return { allowed: true };
  }

  /** Record actual spend after a call completes. */
  record(model: string, cost: number): void {
    this.rollIfNewPeriod();
    this.total += cost;
    this.byModel[model] = (this.byModel[model] ?? 0) + cost;
  }

  snapshot(): SpendSnapshot {
    this.rollIfNewPeriod();
    return {
      period: this.period,
      currency: this.currency,
      total: this.total,
      ceiling: this.ceiling,
      softThreshold: this.ceiling * this.softRatio,
      byModel: { ...this.byModel },
    };
  }

  private nextPeriod(): string {
    const d = this.now();
    return periodKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
  }
}

/** Raised when a routine task is shed because the budget is exhausted/throttled. */
export class BudgetExceededError extends Error {
  constructor(
    readonly reason: 'ceiling_exceeded' | 'soft_throttled',
    readonly retryAfterPeriod: string,
  ) {
    super(`AI budget ${reason}; retry in period ${retryAfterPeriod}`);
    this.name = 'BudgetExceededError';
  }
}
