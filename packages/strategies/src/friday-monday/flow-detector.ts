/**
 * Pure OHLC math for strategy #7 (Friday→Monday flow, T2.7): the "closing near
 * the weekly high" entry test and the position-management exit rules
 * (Monday-weakness auto-cancel, mid-week exit into strength, end-of-week time
 * stop). No I/O, no clock — fixture-testable.
 */
import type { Candle, ExitAction } from "@magpie/core";

/** Tunable thresholds. */
export interface FridayMondayParams {
  /** Daily candle timeframe key stored in `candles.timeframe`. */
  candleTimeframe: string;
  /** How many daily bars to pull. */
  lookbackBars: number;
  /** Sessions defining the "weekly high" the Friday close must sit near. */
  weekHighWindow: number;
  /** Friday close must be within this fraction of the weekly high. */
  nearHighPct: number;
  /** Buy-stop entry buffer above Friday's high (Monday must confirm strength). */
  entryBufferPct: number;
  /** Protective stop distance below the Friday close, as a fraction. */
  stopPct: number;
  /** Mid-week strength target above the Friday close, as a fraction. */
  targetPct: number;
  /** Monday opens "weak" if this fraction (or more) below the Friday close. */
  weakOpenPct: number;
}

export const DEFAULT_FRIDAY_MONDAY_PARAMS: FridayMondayParams = Object.freeze({
  candleTimeframe: "1d",
  lookbackBars: 15,
  weekHighWindow: 5,
  nearHighPct: 0.02,
  entryBufferPct: 0.001,
  stopPct: 0.04,
  targetPct: 0.06,
  weakOpenPct: 0.01,
});

/** A detected Friday "closing near the weekly high" setup. */
export interface WeeklyHighSetup {
  /** Friday close (the strength reference). */
  readonly fridayClose: number;
  /** Friday high (buy-stop entry reference). */
  readonly fridayHigh: number;
  /** Highest high across the week window. */
  readonly weekHigh: number;
  /** How far the close sits below the weekly high (0 = at the high). */
  readonly belowHighPct: number;
}

/** Highest high across the last `window` bars (inclusive of the last). */
function maxHigh(candles: Candle[], window: number): number | null {
  if (candles.length < 1 || window <= 0) return null;
  const start = Math.max(0, candles.length - window);
  let hi = -Infinity;
  for (let i = start; i < candles.length; i++)
    hi = Math.max(hi, candles[i]!.high);
  return hi;
}

/**
 * Detect a Friday close near the weekly high: the last bar's close is within
 * `nearHighPct` of the highest high over the `weekHighWindow` window, and it is a
 * strong (up) close. Returns the setup or `null`.
 */
export function detectWeeklyHighClose(
  candles: Candle[],
  params: FridayMondayParams = DEFAULT_FRIDAY_MONDAY_PARAMS,
): WeeklyHighSetup | null {
  if (candles.length < params.weekHighWindow) return null;
  const last = candles[candles.length - 1]!;
  const weekHigh = maxHigh(candles, params.weekHighWindow);
  if (weekHigh === null || weekHigh <= 0) return null;

  const belowHighPct = (weekHigh - last.close) / weekHigh;
  const nearHigh = belowHighPct <= params.nearHighPct;
  const strongClose = last.close > last.open; // closed up into the weekend
  if (!nearHigh || !strongClose) return null;

  return {
    fridayClose: last.close,
    fridayHigh: last.high,
    weekHigh,
    belowHighPct,
  };
}

/** Per-ticker snapshot refreshed by `scan` every cycle, for sync `manage`. */
export interface FlowView {
  readonly asOf: Date;
  readonly todayOpen: number;
  readonly todayHigh: number;
  readonly todayClose: number;
  /** Today is the first trading session of its week (the Monday check). */
  readonly isWeekOpen: boolean;
  /** Today is the last trading session of its week (the time-stop). */
  readonly isWeekClose: boolean;
  /** Close of the most recent prior week-close session (the entry Friday). */
  readonly priorWeekClose: number | null;
}

/**
 * The exit decision for an open Friday→Monday position, given the latest cached
 * {@link FlowView}. Pure so every rule is unit-testable.
 *
 * Priority: (1) Monday-open weakness ⇒ auto-cancel / flatten the flow trade — the
 * weekend-continuation thesis is dead the moment Monday gaps down; (2) mid-week
 * exit into strength once the move hits the target; (3) end-of-week time stop —
 * the flow trade is not a multi-week hold. Returns `null` to hold.
 */
export function flowExitDecision(
  view: FlowView,
  params: FridayMondayParams = DEFAULT_FRIDAY_MONDAY_PARAMS,
): ExitAction | null {
  // (1) Monday-open weakness — the auto-cancel.
  if (view.isWeekOpen && view.priorWeekClose !== null) {
    const weakThreshold = view.priorWeekClose * (1 - params.weakOpenPct);
    if (view.todayOpen < weakThreshold) {
      return {
        kind: "close",
        reason:
          "Monday opened weak below Friday's close — auto-cancel the flow",
      };
    }
  }

  // (2) Mid-week exit into strength — sell the follow-through spike.
  if (view.priorWeekClose !== null) {
    const target = view.priorWeekClose * (1 + params.targetPct);
    if (view.todayHigh >= target) {
      return {
        kind: "close",
        reason: `Reached the mid-week strength target (+${(params.targetPct * 100).toFixed(0)}%)`,
      };
    }
  }

  // (3) End-of-week time stop — flat into the next weekend.
  if (view.isWeekClose) {
    return {
      kind: "close",
      reason:
        "End-of-week time stop — flow trades don't hold over a second weekend",
    };
  }

  return null;
}
