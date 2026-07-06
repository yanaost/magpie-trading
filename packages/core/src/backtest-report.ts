/**
 * Backtest report (T3.5) — the §4.4 standard report, computed purely in core so
 * the money-path math stays unit-testable and framework-free.
 *
 * A report combines three things a promotion reviewer needs to judge a run:
 *
 *   1. {@link PerformanceStats} — win rate, avg R, max drawdown, equity curve
 *      (reused verbatim from {@link computePerformance});
 *   2. {@link VetoStats} — per-rule signal disposition (how many signals the LLM
 *      vetoed, the crowding filter blocked, the risk manager rejected, the AUTO
 *      governor capped, vs. actually executed) — this is where you learn *why*
 *      a variant traded as much or as little as it did;
 *   3. {@link StubbingCaveat} — how much of the run's LLM analysis was
 *      *synthesized* rather than replayed from a real cached verdict. Historical
 *      news context can't be fully reconstructed, so backtests stub missing
 *      analyses with a configurable pass rate. A report where any analysis was
 *      stubbed is flagged `replayStubbed` and must be read as directional only —
 *      replay-with-cache and live-sim are the real evidence.
 */
import {
  computePerformance,
  type ClosedTrade,
  type PerformanceStats,
} from "./performance.js";
import type { SimClosedTrade } from "./simulator.js";

/**
 * Per-rule signal disposition over a run — every scanned signal lands in exactly
 * one bucket. The buckets mirror the pipeline's `SignalOutcome` kinds.
 */
export interface VetoStats {
  /** Total signals that produced an outcome. */
  readonly signals: number;
  /** Placed as a live bracket (AUTO). */
  readonly executed: number;
  /** Surfaced as a pending proposal (APPROVE). */
  readonly proposed: number;
  /** Logged only, no order (WATCH). */
  readonly watched: number;
  /** Vetoed by the LLM analyst. */
  readonly vetoedByLlm: number;
  /** Blocked by the crowding filter (strategy #6). */
  readonly vetoedByCrowding: number;
  /** Rejected by the deterministic risk manager. */
  readonly riskRejected: number;
  /** Blocked by the AUTO governor's daily cap / cooldown (T3.4). */
  readonly autoCapped: number;
}

/** How much of a run's LLM analysis was stubbed rather than genuinely replayed. */
export interface StubbingCaveat {
  /** Total LLM analyses performed during the run. */
  readonly analyses: number;
  /** How many were replay-stubbed (no cached historical verdict). */
  readonly stubbed: number;
  /** stubbed / analyses, 0..1 (0 when no analyses ran). */
  readonly stubbedFraction: number;
}

/** The full §4.4 backtest report artifact. */
export interface BacktestReport {
  readonly performance: PerformanceStats;
  readonly vetoStats: VetoStats;
  readonly stubbing: StubbingCaveat;
  /**
   * True when *any* analysis in the run was stubbed — the visible `REPLAY_STUBBED`
   * caveat. A `false` report ran entirely off cached/real verdicts.
   */
  readonly replayStubbed: boolean;
}

/** Zero-state veto stats. */
export function emptyVetoStats(): VetoStats {
  return {
    signals: 0,
    executed: 0,
    proposed: 0,
    watched: 0,
    vetoedByLlm: 0,
    vetoedByCrowding: 0,
    riskRejected: 0,
    autoCapped: 0,
  };
}

/**
 * Tally a run's signal outcomes into {@link VetoStats}. Accepts anything with a
 * `kind` discriminant (the pipeline's `SignalOutcome`), so core needn't depend on
 * the API's union. Unknown kinds are counted in `signals` but no bucket.
 */
export function tallyOutcomes(
  outcomes: readonly { readonly kind: string }[],
): VetoStats {
  let executed = 0;
  let proposed = 0;
  let watched = 0;
  let vetoedByLlm = 0;
  let vetoedByCrowding = 0;
  let riskRejected = 0;
  let autoCapped = 0;
  for (const o of outcomes) {
    switch (o.kind) {
      case "executed":
        executed += 1;
        break;
      case "proposed":
        proposed += 1;
        break;
      case "watched":
        watched += 1;
        break;
      case "vetoed":
        vetoedByLlm += 1;
        break;
      case "crowded":
        vetoedByCrowding += 1;
        break;
      case "risk-rejected":
        riskRejected += 1;
        break;
      case "auto-capped":
        autoCapped += 1;
        break;
      default:
        break;
    }
  }
  return {
    signals: outcomes.length,
    executed,
    proposed,
    watched,
    vetoedByLlm,
    vetoedByCrowding,
    riskRejected,
    autoCapped,
  };
}

/**
 * Map a simulator's closed trades to {@link ClosedTrade} for the performance
 * math, dropping any that never filled (cancelled before entry → no entryPrice,
 * not a real trade). Preserves close order for the equity curve.
 */
export function simTradesToClosedTrades(
  trades: readonly SimClosedTrade[],
): ClosedTrade[] {
  const out: ClosedTrade[] = [];
  for (const t of trades) {
    if (t.entryPrice === undefined) continue;
    out.push({
      realizedPnl: t.realizedPnl,
      qty: t.qty,
      entryPrice: t.entryPrice,
      stopPrice: t.stopPrice,
      closedAt: t.closedAt,
    });
  }
  return out;
}

/** Assemble a {@link BacktestReport} from a run's raw outputs. */
export function buildBacktestReport(input: {
  readonly trades: readonly ClosedTrade[];
  readonly outcomes: readonly { readonly kind: string }[];
  readonly analyses: number;
  readonly stubbed: number;
}): BacktestReport {
  const performance = computePerformance(input.trades);
  const vetoStats = tallyOutcomes(input.outcomes);
  const analyses = Math.max(0, input.analyses);
  const stubbed = Math.max(0, input.stubbed);
  return {
    performance,
    vetoStats,
    stubbing: {
      analyses,
      stubbed,
      stubbedFraction: analyses === 0 ? 0 : stubbed / analyses,
    },
    replayStubbed: stubbed > 0,
  };
}
