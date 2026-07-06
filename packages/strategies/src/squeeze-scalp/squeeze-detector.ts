/**
 * Squeeze-scalp detector (strategy #4, T3.3) — pure intraday logic, no I/O, so
 * the chase guard and the scale-out ladder are directly unit-testable and replay
 * is deterministic.
 *
 * A heavily-shorted name breaks out intraday when a real catalyst hits. The
 * tradeable moment is a *resistance break on volume*, but only if the stock is
 * not already extended — the **chase guard** vetoes any entry once the name is
 * already up past `chaseGuardGainPct` on the day (the squeeze fuel is spent and
 * the risk/reward has inverted). Exits are scaled: bank half into strength, run
 * the rest to a larger target.
 */
import type { Candle } from "@magpie/core";

/** Tunable detector parameters. */
export interface SqueezeParams {
  /** Bars of prior range whose high defines resistance (excludes the break). */
  readonly resistanceLookback: number;
  /** Latest-bar volume must exceed the recent average by this multiple. */
  readonly volumeMultiple: number;
  /** No entry once the day's gain (from the session open) reaches this. */
  readonly chaseGuardGainPct: number;
}

export const DEFAULT_SQUEEZE_PARAMS: SqueezeParams = Object.freeze({
  resistanceLookback: 6,
  volumeMultiple: 1.5,
  chaseGuardGainPct: 0.3,
});

/** A detected catalyst breakout — the technicals the proposal prices off. */
export interface SqueezeSetup {
  /** The breakout price (latest close above resistance) — the entry ref. */
  readonly breakoutPrice: number;
  /** The intraday resistance that was broken. */
  readonly resistance: number;
  /** Latest bar volume vs the recent average (>1 means rising). */
  readonly volumeRatio: number;
  /** Day gain from the session open at the signal bar (chase-guard input). */
  readonly intradayGainPct: number;
}

/** Day gain from the session open: `(latestClose − sessionOpen) / sessionOpen`. */
export function intradayGainPct(candles: readonly Candle[]): number {
  if (candles.length === 0) return 0;
  const open = candles[0]!.open;
  if (open <= 0) return 0;
  const last = candles[candles.length - 1]!.close;
  return (last - open) / open;
}

/**
 * Detect a catalyst breakout in a session's intraday candles (oldest→newest).
 * Returns the setup, or `null` if there is no break, no volume confirmation, or
 * the chase guard is tripped.
 *
 * @param candles - the session's bars up to and including the current one
 * @param params - detector tuning
 */
export function detectSqueezeBreakout(
  candles: readonly Candle[],
  params: SqueezeParams = DEFAULT_SQUEEZE_PARAMS,
): SqueezeSetup | null {
  if (candles.length < 2) return null;
  const latest = candles[candles.length - 1]!;

  // Chase guard: refuse to chase a name that has already run.
  const gain = intradayGainPct(candles);
  if (gain >= params.chaseGuardGainPct) return null;

  // Resistance is the high of the prior `resistanceLookback` bars (not the
  // breakout bar itself).
  const prior = candles.slice(-1 - params.resistanceLookback, -1);
  if (prior.length === 0) return null;
  const resistance = Math.max(...prior.map((c) => c.high));

  // Breakout: latest close clears resistance.
  if (!(latest.close > resistance)) return null;

  // On volume: the break must be confirmed by above-average participation.
  const avgVolume = prior.reduce((sum, c) => sum + c.volume, 0) / prior.length;
  const volumeRatio = avgVolume > 0 ? latest.volume / avgVolume : 0;
  if (!(volumeRatio >= params.volumeMultiple)) return null;

  return {
    breakoutPrice: latest.close,
    resistance,
    volumeRatio,
    intradayGainPct: gain,
  };
}

/** Scale-out ladder parameters. */
export interface ScaleOutParams {
  /** Bank the first tranche once the position is up this fraction. */
  readonly firstTrancheGainPct: number;
  /** Fraction of the original quantity to bank at the first tranche. */
  readonly firstTrancheFraction: number;
  /** Exit the runner once the position reaches this gain. */
  readonly runnerGainPct: number;
}

export const DEFAULT_SCALE_OUT_PARAMS: ScaleOutParams = Object.freeze({
  firstTrancheGainPct: 0.05,
  firstTrancheFraction: 0.5,
  runnerGainPct: 0.1,
});

/** What the scale-out ladder decides at the current price. */
export type ScaleOutDecision =
  | { readonly action: "hold" }
  | { readonly action: "scale-out"; readonly qty: number }
  | { readonly action: "close" };

/**
 * Pure scale-out ladder for an open squeeze position. Given the entry price, the
 * original filled quantity, the remaining quantity, and the current price, it
 * decides whether to bank the first tranche, exit the runner, or hold.
 *
 * Statelessness is preserved by gating the first tranche on the remaining
 * quantity still being the full position — once banked, `remainingQty` drops
 * below `entryQty`, so the first rung cannot re-fire. The runner rung fires only
 * after the first tranche has already been taken.
 */
export function planScaleOut(
  entryPrice: number,
  entryQty: number,
  remainingQty: number,
  currentPrice: number,
  params: ScaleOutParams = DEFAULT_SCALE_OUT_PARAMS,
): ScaleOutDecision {
  if (remainingQty <= 0 || entryPrice <= 0 || entryQty <= 0) {
    return { action: "hold" };
  }
  const gain = (currentPrice - entryPrice) / entryPrice;

  // Runner: once at the far target, close whatever remains.
  if (gain >= params.runnerGainPct) {
    return { action: "close" };
  }

  // First tranche: only while the position is still whole (prevents re-firing).
  if (gain >= params.firstTrancheGainPct && remainingQty >= entryQty) {
    const qty = Math.floor(entryQty * params.firstTrancheFraction);
    if (qty > 0 && qty < remainingQty) {
      return { action: "scale-out", qty };
    }
  }

  return { action: "hold" };
}
