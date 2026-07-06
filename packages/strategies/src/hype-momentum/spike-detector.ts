/**
 * Pure OHLCV math for strategy #2 (hype momentum, T2.6): the volume-spike
 * breakout detector and the position-management exit rules. No I/O, no clock —
 * everything is fixture-testable (AC: "exit-rule unit tests incl. the
 * earnings-block; replay over a fixtured spike week").
 */
import type { Candle, ExitAction } from "@magpie/core";

/** Tunable thresholds for the spike detector and exit logic. */
export interface HypeMomentumParams {
  /** Daily candle timeframe key stored in `candles.timeframe`. */
  candleTimeframe: string;
  /** How many daily bars to pull for averages + resistance. */
  lookbackBars: number;
  /** Trailing window (bars) for the average-volume baseline. */
  volAvgWindow: number;
  /** Breakout volume must be ≥ this multiple of the trailing average. */
  volSpikeMult: number;
  /** Lookback (bars) whose high defines the resistance the breakout must clear. */
  resistanceLookback: number;
  /** Take-profit for the first half, as a fraction above entry. */
  takeProfitPct: number;
  /** Protective hard-stop distance below entry, as a fraction. */
  stopPct: number;
  /** MA window (bars) whose breach exits the remainder. */
  maExitWindow: number;
  /** A "heavy-volume" stall day is ≥ this multiple of the trailing average. */
  stallVolMult: number;
  /** Exit if scheduled earnings fall within this many calendar days. */
  earningsBlockDays: number;
}

export const DEFAULT_HYPE_MOMENTUM_PARAMS: HypeMomentumParams = Object.freeze({
  candleTimeframe: "1d",
  lookbackBars: 30,
  volAvgWindow: 20,
  volSpikeMult: 2.5,
  resistanceLookback: 20,
  takeProfitPct: 0.15,
  stopPct: 0.08,
  maExitWindow: 5,
  stallVolMult: 1.5,
  earningsBlockDays: 3,
});

/** A detected fresh volume-spike breakout (the entry trigger). */
export interface HypeSpikeResult {
  /** Index of the breakout candle (the latest bar). */
  readonly spikeIndex: number;
  /** Close of the breakout candle (entry reference). */
  readonly spikeClose: number;
  /** Volume of the breakout candle. */
  readonly spikeVolume: number;
  /** Trailing average volume the breakout is measured against. */
  readonly avgVolume: number;
  /** Volume as a multiple of the trailing average. */
  readonly volMult: number;
  /** Prior resistance (high) the breakout cleared. */
  readonly resistance: number;
}

/** Mean of the last `window` volumes ending just before `endExclusive`. */
function avgVolumeBefore(
  candles: Candle[],
  endExclusive: number,
  window: number,
): number | null {
  const start = endExclusive - window;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i < endExclusive; i++) sum += candles[i]!.volume;
  return sum / window;
}

/** Highest high over `[endExclusive - window, endExclusive)`. */
function maxHighBefore(
  candles: Candle[],
  endExclusive: number,
  window: number,
): number | null {
  const start = endExclusive - window;
  if (start < 0) return null;
  let hi = -Infinity;
  for (let i = start; i < endExclusive; i++)
    hi = Math.max(hi, candles[i]!.high);
  return hi;
}

/**
 * Detect a *fresh* volume-spike breakout on the last bar of the series: an
 * up-day whose volume is ≥ `volSpikeMult`× the trailing average and whose close
 * clears the prior-`resistanceLookback` high. Firing only on the last bar makes
 * it a once-per-spike trigger (like QUAL/SPHB's fresh-cross), so entries land on
 * day 1 of the spike.
 *
 * @returns the breakout, or `null` when the last bar is not a fresh breakout
 */
export function detectHypeSpike(
  candles: Candle[],
  params: HypeMomentumParams = DEFAULT_HYPE_MOMENTUM_PARAMS,
): HypeSpikeResult | null {
  const n = candles.length;
  const need = Math.max(params.volAvgWindow, params.resistanceLookback) + 1;
  if (n < need) return null;

  const last = candles[n - 1]!;
  const avgVolume = avgVolumeBefore(candles, n - 1, params.volAvgWindow);
  const resistance = maxHighBefore(candles, n - 1, params.resistanceLookback);
  if (avgVolume === null || resistance === null || avgVolume <= 0) return null;

  const volMult = last.volume / avgVolume;
  const isUpDay = last.close > last.open;
  const brokeOut = last.close > resistance;
  const volSpike = volMult >= params.volSpikeMult;
  if (!isUpDay || !brokeOut || !volSpike) return null;

  return {
    spikeIndex: n - 1,
    spikeClose: last.close,
    spikeVolume: last.volume,
    avgVolume,
    volMult,
    resistance,
  };
}

/** Per-ticker snapshot cached by `scan`, read synchronously by `manage`. */
export interface HypeView {
  /** Scan timestamp (for the earnings-window check). */
  readonly asOf: Date;
  readonly lastOpen: number;
  readonly lastClose: number;
  readonly lastHigh: number;
  readonly lastVolume: number;
  /** Previous bar's high — a lower high signals a momentum stall. */
  readonly priorHigh: number;
  /** Trailing average volume (heavy-volume threshold reference). */
  readonly avgVolume: number;
  /** `maExitWindow`-bar moving average of closes (breach exits the remainder). */
  readonly maExit: number;
  /** Next scheduled earnings date (ISO `YYYY-MM-DD`), or null if unknown. */
  readonly nextEarningsDate: string | null;
}

/** Whole calendar days from `asOf` until `isoDate` (negative if already past). */
function daysUntil(asOf: Date, isoDate: string): number {
  const target = Date.parse(`${isoDate}T00:00:00.000Z`);
  const from = Date.parse(`${asOf.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return Math.round((target - from) / (24 * 60 * 60 * 1000));
}

/**
 * The exit decision for an open hype-momentum position, given the latest cached
 * {@link HypeView}. Pure — takes explicit inputs so every rule (including the
 * hard earnings-block) is unit-testable without a MarketContext.
 *
 * Priority: (1) hard exit before any upcoming earnings date, (2) momentum stall
 * — first heavy-volume red day, (3) momentum stall — lower high that rolls over,
 * (4) written exit — close below the exit MA. Returns `null` to hold.
 */
export function hypeExitDecision(
  view: HypeView,
  params: HypeMomentumParams = DEFAULT_HYPE_MOMENTUM_PARAMS,
): ExitAction | null {
  // (1) Hard rule: never hold a hype name into its earnings print.
  if (view.nextEarningsDate !== null) {
    const days = daysUntil(view.asOf, view.nextEarningsDate);
    if (days >= 0 && days <= params.earningsBlockDays) {
      return {
        kind: "close",
        reason: `Exit before earnings on ${view.nextEarningsDate} (in ${days}d) — hard rule`,
      };
    }
  }

  const redDay = view.lastClose < view.lastOpen;

  // (2) Momentum stall — first heavy-volume red day (distribution).
  if (redDay && view.lastVolume >= params.stallVolMult * view.avgVolume) {
    return {
      kind: "close",
      reason: "Momentum stall: heavy-volume red day (distribution)",
    };
  }

  // (3) Momentum stall — a lower high that rolls over (failed to extend).
  if (redDay && view.lastHigh < view.priorHigh) {
    return {
      kind: "close",
      reason: "Momentum stall: lower high — advance failed",
    };
  }

  // (4) Written exit — remainder out on a close below the exit MA.
  if (view.lastClose < view.maExit) {
    return {
      kind: "close",
      reason: `Closed below the ${params.maExitWindow}-day MA — trend broken`,
    };
  }

  return null;
}

/** `window`-bar simple moving average of closes (ending at the last bar). */
export function closeMA(candles: Candle[], window: number): number | null {
  if (candles.length < window || window <= 0) return null;
  let sum = 0;
  for (let i = candles.length - window; i < candles.length; i++) {
    sum += candles[i]!.close;
  }
  return sum / window;
}
