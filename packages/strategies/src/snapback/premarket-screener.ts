/**
 * Pre-market gap-down screener port for strategy #5 (snapback, T3.2).
 *
 * The snapback thesis starts from a pre-market scan: small-cap names ($300M–$2B)
 * that are down ≥10% *before* the open. That screen is external data (a
 * pre-market mover feed / screener export), so it arrives through this small
 * port — a real adapter in production, a {@link StaticPremarketScreener} seeded
 * from fixtures in tests and replay. Market cap + gap % are the raw fields; the
 * band/threshold filtering lives here so the strategy just consumes candidates.
 */
import type { Ticker } from "@magpie/core";

/** A pre-market mover: a name and the numbers that qualify it. */
export interface PremarketGapper {
  /** Symbol. */
  readonly ticker: Ticker;
  /** Prior session's closing price — the gap reference for the fill target. */
  readonly prevClose: number;
  /** Indicative pre-market price used to compute the gap. */
  readonly premarketPrice: number;
  /** Market capitalization in USD (for the small-cap band filter). */
  readonly marketCap: number;
}

/** Band/threshold config for what counts as a snapback candidate. */
export interface PremarketScreenParams {
  /** Minimum market cap, USD (spec: $300M). */
  readonly minMarketCap: number;
  /** Maximum market cap, USD (spec: $2B). */
  readonly maxMarketCap: number;
  /** Minimum gap-down as a positive fraction (spec: 0.10 = down ≥10%). */
  readonly minGapDownPct: number;
}

export const DEFAULT_PREMARKET_SCREEN_PARAMS: PremarketScreenParams =
  Object.freeze({
    minMarketCap: 300_000_000,
    maxMarketCap: 2_000_000_000,
    minGapDownPct: 0.1,
  });

/** Down-gap as a positive fraction: `(prevClose − premarket) / prevClose`. */
export function gapDownPct(g: PremarketGapper): number {
  if (g.prevClose <= 0) return 0;
  return (g.prevClose - g.premarketPrice) / g.prevClose;
}

/** Supplies the qualifying pre-market gappers to scan for a reclaim. */
export interface PremarketScreener {
  /**
   * Names down past the threshold inside the cap band as of `asOf`.
   * @param asOf - logical "now" for the run
   */
  gappers(asOf: Date): Promise<PremarketGapper[]>;
}

/**
 * Fixture/config-backed screener: a fixed candidate list, filtered to the
 * small-cap band and the minimum gap. Deterministic — the registry default
 * (empty until a real pre-market feed is wired in) and the fixtures tests seed.
 */
export class StaticPremarketScreener implements PremarketScreener {
  private readonly all: readonly PremarketGapper[];
  private readonly params: PremarketScreenParams;

  constructor(
    candidates: readonly PremarketGapper[] = [],
    params: Partial<PremarketScreenParams> = {},
  ) {
    this.all = [...candidates];
    this.params = { ...DEFAULT_PREMARKET_SCREEN_PARAMS, ...params };
  }

  async gappers(): Promise<PremarketGapper[]> {
    const { minMarketCap, maxMarketCap, minGapDownPct } = this.params;
    return this.all
      .filter(
        (g) =>
          g.marketCap >= minMarketCap &&
          g.marketCap <= maxMarketCap &&
          gapDownPct(g) >= minGapDownPct,
      )
      .sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  }
}
