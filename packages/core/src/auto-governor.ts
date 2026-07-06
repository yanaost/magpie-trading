/**
 * AUTO-mode governor (spec §3.2, T3.4) — the safety brake that lets the fast
 * intraday strategies (#4 squeeze-scalp, #5 snapback) run unattended without
 * bleeding on a pathological day.
 *
 * Two independent circuit breakers, both pure and per-strategy:
 *
 *  1. **Daily trade cap** — at most `maxTradesPerDay` auto entries per UTC day.
 *     Spent caps block further auto entries until the next day (the signals
 *     still flow; they just aren't auto-executed).
 *  2. **Consecutive-loss cooldown** — after `maxConsecutiveLosses` losing trades
 *     in a row, the strategy is *demoted* from AUTO to APPROVE so a human takes
 *     the wheel. A win resets the streak.
 *
 * The governor holds only counters (no I/O, no clock of its own — the caller
 * passes `now`), so caps/cooldown are unit-testable in isolation and the replay
 * chaos test is deterministic. The caller (the pipeline) owns the side effects:
 * skipping a capped entry, and persisting the AUTO→APPROVE demotion.
 */

/** Tunable governor thresholds. */
export interface AutoGovernorParams {
  /** Maximum auto entries per strategy per UTC day. */
  readonly maxTradesPerDay: number;
  /** Demote AUTO→APPROVE after this many consecutive losing trades. */
  readonly maxConsecutiveLosses: number;
}

export const DEFAULT_AUTO_GOVERNOR_PARAMS: AutoGovernorParams = Object.freeze({
  maxTradesPerDay: 5,
  maxConsecutiveLosses: 3,
});

/** Whether an auto entry may proceed, with the reason when it may not. */
export type AdmitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** The result of recording one closed trade against a strategy. */
export interface ResultOutcome {
  /** True on the transition that trips the cooldown (fires exactly once). */
  readonly demote: boolean;
  /** Current consecutive-loss streak after this trade. */
  readonly consecutiveLosses: number;
  /** Whether the strategy is now in the demoted (cooled-down) state. */
  readonly demoted: boolean;
}

/** Per-strategy mutable counters. */
interface StrategyState {
  /** UTC day (YYYY-MM-DD) the `tradesToday` counter belongs to. */
  day: string;
  tradesToday: number;
  consecutiveLosses: number;
  demoted: boolean;
}

/** The UTC calendar day key (YYYY-MM-DD) a timestamp falls in. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * In-process AUTO-mode governor. One instance is shared across the process (the
 * counters must survive between ticks); it is keyed by strategy id so every
 * strategy has independent caps and cooldown.
 */
export class AutoGovernor {
  private readonly params: AutoGovernorParams;
  private readonly state = new Map<string, StrategyState>();

  /**
   * @param params - cap/cooldown thresholds (defaults per spec §3.2)
   */
  constructor(params: Partial<AutoGovernorParams> = {}) {
    this.params = { ...DEFAULT_AUTO_GOVERNOR_PARAMS, ...params };
  }

  /** Fetch (creating on first touch) the counters for a strategy at `now`. */
  private stateFor(strategyId: string, now: Date): StrategyState {
    let s = this.state.get(strategyId);
    if (!s) {
      s = {
        day: utcDay(now),
        tradesToday: 0,
        consecutiveLosses: 0,
        demoted: false,
      };
      this.state.set(strategyId, s);
    }
    // Roll the daily counter over at the UTC day boundary.
    const day = utcDay(now);
    if (s.day !== day) {
      s.day = day;
      s.tradesToday = 0;
    }
    return s;
  }

  /**
   * Whether a new auto entry may proceed for `strategyId` at `now`. Blocks once
   * the strategy is demoted (its signals should route through APPROVE, not
   * execute) or the daily cap is spent.
   */
  admitEntry(strategyId: string, now: Date): AdmitDecision {
    const s = this.stateFor(strategyId, now);
    if (s.demoted) {
      return {
        allowed: false,
        reason: "AUTO demoted to APPROVE after consecutive losses",
      };
    }
    if (s.tradesToday >= this.params.maxTradesPerDay) {
      return {
        allowed: false,
        reason: `daily auto-trade cap reached (${this.params.maxTradesPerDay})`,
      };
    }
    return { allowed: true };
  }

  /** Record that an auto entry was placed (increments the daily counter). */
  recordEntry(strategyId: string, now: Date): void {
    const s = this.stateFor(strategyId, now);
    s.tradesToday += 1;
  }

  /**
   * Record one closed trade's realized P&L. A loss (`realizedPnl < 0`) extends
   * the streak; anything else resets it. When the streak first reaches
   * `maxConsecutiveLosses` the strategy is demoted and `demote` is returned true
   * exactly once (subsequent losses keep it demoted but don't re-fire).
   */
  recordResult(
    strategyId: string,
    realizedPnl: number,
    now: Date,
  ): ResultOutcome {
    const s = this.stateFor(strategyId, now);
    if (realizedPnl < 0) {
      s.consecutiveLosses += 1;
    } else {
      s.consecutiveLosses = 0;
    }
    let demote = false;
    if (!s.demoted && s.consecutiveLosses >= this.params.maxConsecutiveLosses) {
      s.demoted = true;
      demote = true;
    }
    return {
      demote,
      consecutiveLosses: s.consecutiveLosses,
      demoted: s.demoted,
    };
  }

  /** Whether the strategy is currently in the demoted (cooled-down) state. */
  isDemoted(strategyId: string, now: Date): boolean {
    return this.stateFor(strategyId, now).demoted;
  }

  /**
   * Clear the cooldown for a strategy (e.g. a human re-promotes it to AUTO).
   * Resets the loss streak and the demoted flag; leaves the daily cap intact.
   */
  clearCooldown(strategyId: string, now: Date): void {
    const s = this.stateFor(strategyId, now);
    s.consecutiveLosses = 0;
    s.demoted = false;
  }
}
