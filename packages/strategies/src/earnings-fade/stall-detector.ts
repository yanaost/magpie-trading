/**
 * Post-earnings bounce-stall detector for strategy #1 (earnings fade, T2.5).
 *
 * The setup: a company misses / guides down, the market punishes it on the
 * reaction session (a sharp down move), then over the next 2–3 sessions it makes
 * a dead-cat *bounce that stalls below the reaction-day high* and rolls over.
 * That failed bounce is the fade trigger — the drop is resuming, so a long-only
 * account should not buy the dip (and, with options permissions, long puts are
 * the executable expression).
 *
 * This module is pure OHLC math with no I/O so it can be nailed down with
 * fixtures (AC: "fixture-driven tests for the stall detector").
 */
import type { Candle } from "@magpie/core";

/** Tunable thresholds for the stall detector. */
export interface StallParams {
  /** Minimum reaction-day drop (fraction, e.g. 0.05 = −5%) to call it a miss. */
  minReactionDropPct: number;
  /** Sessions after the reaction day to watch for a failed bounce (day 2..N). */
  stallWindow: number;
  /**
   * How close under the reaction high still counts as "stalled below" it — the
   * bounce high must stay at least this fraction below the reaction high
   * (0 = simply below it).
   */
  belowHighMargin: number;
}

export const DEFAULT_STALL_PARAMS: StallParams = Object.freeze({
  minReactionDropPct: 0.05,
  stallWindow: 3,
  belowHighMargin: 0,
});

/** A detected post-earnings stall (the fade trigger). */
export interface StallResult {
  /** Index of the earnings reaction candle in the input series. */
  readonly reactionIndex: number;
  /** Index of the failed-bounce (stall) candle. */
  readonly stallIndex: number;
  /** High of the reaction day — the level the bounce failed to reclaim. */
  readonly postEarningsHigh: number;
  /** Reaction-day move vs the prior close (negative for a miss). */
  readonly reactionMovePct: number;
  /** Low of the reaction day — the initial downside target reference. */
  readonly reactionLow: number;
  /** Close of the stall candle (fade entry reference). */
  readonly stallClose: number;
}

/** ISO calendar date (YYYY-MM-DD) of a candle's open time, in UTC. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Detect a post-earnings bounce-stall in a daily candle series.
 *
 * @param candles - daily bars oldest→newest, spanning at least the session
 *   before the report through a few sessions after it
 * @param reportDate - the earnings report date (ISO `YYYY-MM-DD`); the reaction
 *   candle is the first session on/after this date
 * @param params - detector thresholds
 * @returns the stall trigger, or `null` if the pattern is absent
 */
export function detectPostEarningsStall(
  candles: Candle[],
  reportDate: string,
  params: StallParams = DEFAULT_STALL_PARAMS,
): StallResult | null {
  // Reaction candle = first session on/after the report date.
  const reactionIndex = candles.findIndex((c) => isoDate(c.ts) >= reportDate);
  // Need a prior session (for the reaction move) and at least one bounce session.
  if (reactionIndex <= 0 || reactionIndex >= candles.length - 1) return null;

  const priorClose = candles[reactionIndex - 1]!.close;
  const reaction = candles[reactionIndex]!;
  if (priorClose <= 0) return null;

  // Require a genuinely punished report — a sharp down reaction.
  const reactionMovePct = (reaction.close - priorClose) / priorClose;
  if (reactionMovePct > -params.minReactionDropPct) return null;

  const postEarningsHigh = reaction.high;
  const reactionClose = reaction.close;
  const ceiling = postEarningsHigh * (1 - params.belowHighMargin);

  // Walk the bounce window (day 2..N) for the first failed-bounce stall. The
  // failed bounce is a single session that pokes UP above the prior close
  // (a dip-buy attempt), stays capped below the post-earnings high, then closes
  // RED — the bounce rejected. The intraday high must also have recovered above
  // the reaction close, so a straight continuation-down day doesn't qualify.
  const lastIndex = Math.min(
    reactionIndex + params.stallWindow,
    candles.length - 1,
  );
  for (let i = reactionIndex + 1; i <= lastIndex; i++) {
    const bar = candles[i]!;
    const prev = candles[i - 1]!;

    // "Bounce" — poked above the prior close and back above the reaction close...
    const attemptedBounce = bar.high > prev.close && bar.high > reactionClose;
    // ...but "stalled below" the post-earnings high...
    const stalledBelowHigh = bar.high < ceiling;
    // ...and "rolled over" — closed red (rejection of the bounce).
    const rolledOver = bar.close < bar.open;

    if (attemptedBounce && stalledBelowHigh && rolledOver) {
      return {
        reactionIndex,
        stallIndex: i,
        postEarningsHigh,
        reactionMovePct,
        reactionLow: reaction.low,
        stallClose: bar.close,
      };
    }
  }
  return null;
}
