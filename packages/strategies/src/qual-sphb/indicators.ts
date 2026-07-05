/**
 * Pure indicator math for the QUAL/SPHB rotation strategy. No I/O, no clock —
 * everything is a deterministic function of the input series so it replays
 * identically and unit-tests without fixtures.
 */
import type { Candle } from "@magpie/core";

/**
 * The high-beta / quality ratio, bar-aligned. `SPHB.close / QUAL.close` rises
 * when speculative high-beta leads (risk-on euphoria) and falls when quality
 * leads (risk-off). The two series are joined on bar timestamp so mismatched
 * histories don't silently misalign.
 *
 * @param sphb - SPHB weekly candles, oldest→newest
 * @param qual - QUAL weekly candles, oldest→newest
 * @returns the ratio series (oldest→newest), one point per shared timestamp
 */
export function ratioSeries(sphb: Candle[], qual: Candle[]): number[] {
  const qualByTs = new Map<number, number>();
  for (const c of qual) qualByTs.set(c.ts.getTime(), c.close);
  const out: number[] = [];
  for (const c of sphb) {
    const q = qualByTs.get(c.ts.getTime());
    if (q === undefined || q === 0) continue;
    out.push(c.close / q);
  }
  return out;
}

/**
 * Trailing simple moving average. `out[i]` is the mean of `values[i-period+1..i]`
 * once `i >= period-1`, and `null` before enough history exists — so callers
 * can't accidentally treat a warm-up bar as a real average.
 *
 * @param values - the input series, oldest→newest
 * @param period - window length (must be a positive integer)
 * @returns an array the same length as `values`, `null` during warm-up
 */
export function sma(values: number[], period: number): Array<number | null> {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(`sma period must be a positive integer, got ${period}`);
  }
  const out: Array<number | null> = [];
  let running = 0;
  for (let i = 0; i < values.length; i += 1) {
    running += values[i] as number;
    if (i >= period) running -= values[i - period] as number;
    out.push(i >= period - 1 ? running / period : null);
  }
  return out;
}

/** The latest ratio and its trailing SMA, or `null` until the SMA warms up. */
export interface RatioView {
  /** Most recent SPHB/QUAL ratio. */
  readonly ratio: number;
  /** Trailing SMA of the ratio over `period` bars. */
  readonly sma: number;
  /** Previous bar's ratio (for cross detection), when available. */
  readonly prevRatio: number | null;
  /** Previous bar's SMA (for cross detection), when available. */
  readonly prevSma: number | null;
}

/**
 * Reduce the two candle histories to the current {@link RatioView} used by both
 * the scan trigger and the manage exit. Returns `null` until there are at least
 * `period` shared bars (SMA warm-up incomplete).
 *
 * @param sphb - SPHB weekly candles, oldest→newest
 * @param qual - QUAL weekly candles, oldest→newest
 * @param period - SMA window (weeks)
 */
export function ratioView(
  sphb: Candle[],
  qual: Candle[],
  period: number,
): RatioView | null {
  const ratios = ratioSeries(sphb, qual);
  if (ratios.length < period) return null;
  const smaSeries = sma(ratios, period);
  const last = ratios.length - 1;
  const ratio = ratios[last] as number;
  const smaNow = smaSeries[last];
  if (smaNow === null || smaNow === undefined) return null;
  return {
    ratio,
    sma: smaNow,
    prevRatio: last >= 1 ? (ratios[last - 1] as number) : null,
    prevSma: last >= 1 ? (smaSeries[last - 1] ?? null) : null,
  };
}
