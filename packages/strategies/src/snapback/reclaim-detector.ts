/**
 * Snapback reclaim detector (strategy #5, T3.2) — pure intraday OHLC logic, no
 * I/O, so every edge is fixture-testable and replay is deterministic.
 *
 * After a small-cap gaps down with no fundamental news, the tradeable moment is
 * a *higher-low + opening-range-low reclaim on rising volume*, taken only after
 * a deliberate 30–60 minute wait (the open is too noisy). The pattern:
 *
 *   1. **wait** — at least `waitMinutes` have elapsed since the session open;
 *   2. **opening-range low (ORL)** — the low of the first `openingRangeMinutes`;
 *   3. **higher low** — after the day's low printed, a later bar made a *higher*
 *      low (sellers losing control), and price is holding above the day low;
 *   4. **reclaim** — the latest close is back above the ORL;
 *   5. **rising volume** — the latest bar's volume beats the recent average.
 *
 * All five must hold. The stop lives below the day low; the target is a partial
 * gap-fill computed by the strategy from the prior close.
 */
import type { Candle } from "@magpie/core";

/** Tunable detector parameters (defaults from the spec's 30–60 min guidance). */
export interface ReclaimParams {
  /** Minutes to wait after the open before taking any setup (spec: 30–60). */
  readonly waitMinutes: number;
  /** Length of the opening range whose low must be reclaimed, in minutes. */
  readonly openingRangeMinutes: number;
  /** Bars of prior volume the latest bar must exceed the average of. */
  readonly risingVolumeLookback: number;
}

export const DEFAULT_RECLAIM_PARAMS: ReclaimParams = Object.freeze({
  waitMinutes: 45,
  openingRangeMinutes: 15,
  risingVolumeLookback: 3,
});

/** A detected reclaim setup — the raw technicals the proposal prices off. */
export interface ReclaimSetup {
  /** The reclaim price (latest close back above the ORL) — the entry ref. */
  readonly reclaimPrice: number;
  /** Opening-range low that was reclaimed. */
  readonly openingRangeLow: number;
  /** Lowest low of the session so far — the stop sits just below this. */
  readonly dayLow: number;
  /** The higher low that formed after the day low. */
  readonly higherLow: number;
  /** Latest bar volume vs the recent average (>1 means rising). */
  readonly volumeRatio: number;
  /** Minutes elapsed since the session open at the signal bar. */
  readonly elapsedMinutes: number;
}

const MS_PER_MIN = 60_000;

/**
 * Detect a snapback reclaim in a day's intraday candles (oldest→newest, all from
 * the same session). Returns the setup, or `null` if any condition fails.
 *
 * @param candles - the session's bars up to and including the current one
 * @param now - logical current time (the session's "now")
 * @param params - detector tuning
 */
export function detectSnapbackReclaim(
  candles: readonly Candle[],
  now: Date,
  params: ReclaimParams = DEFAULT_RECLAIM_PARAMS,
): ReclaimSetup | null {
  if (candles.length === 0) return null;
  const first = candles[0]!;
  const latest = candles[candles.length - 1]!;

  // 1. Wait: enough of the session must have elapsed.
  const elapsedMinutes = (now.getTime() - first.ts.getTime()) / MS_PER_MIN;
  if (elapsedMinutes < params.waitMinutes) return null;

  // 2. Opening-range low: the low across the first `openingRangeMinutes`.
  const rangeEnd = first.ts.getTime() + params.openingRangeMinutes * MS_PER_MIN;
  const openingBars = candles.filter((c) => c.ts.getTime() < rangeEnd);
  if (openingBars.length === 0) return null;
  const openingRangeLow = Math.min(...openingBars.map((c) => c.low));

  // 3. Higher low: locate the day-low bar, then require a later bar to have made
  // a higher low, and the latest bar to still hold above the day low.
  const dayLow = Math.min(...candles.map((c) => c.low));
  const dayLowIdx = candles.findIndex((c) => c.low === dayLow);
  const after = candles.slice(dayLowIdx + 1);
  if (after.length === 0) return null;
  const higherLow = Math.min(...after.map((c) => c.low));
  if (!(higherLow > dayLow)) return null;
  if (!(latest.low > dayLow)) return null;

  // 4. Reclaim: price back above the opening-range low.
  if (!(latest.close > openingRangeLow)) return null;

  // 5. Rising volume: latest bar beats the recent average.
  const prior = candles.slice(-1 - params.risingVolumeLookback, -1);
  if (prior.length === 0) return null;
  const avgVolume = prior.reduce((sum, c) => sum + c.volume, 0) / prior.length;
  const volumeRatio = avgVolume > 0 ? latest.volume / avgVolume : 0;
  if (!(volumeRatio > 1)) return null;

  return {
    reclaimPrice: latest.close,
    openingRangeLow,
    dayLow,
    higherLow,
    volumeRatio,
    elapsedMinutes,
  };
}
