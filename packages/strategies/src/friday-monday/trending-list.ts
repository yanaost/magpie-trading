/**
 * Injected candidate feed for strategy #7 (Friday→Monday flow, T2.7). Same
 * Provider pattern as the T2.5 earnings calendar: an interface plus a static
 * default so the strategy is deterministic offline.
 */
import type { Ticker } from "@magpie/core";

/**
 * Supplies the Friday trending / most-bought list — names retail is crowding
 * into and that may carry momentum through the weekend gap.
 */
export interface TrendingListProvider {
  /** Trending / most-bought tickers as of `asOf` (a Friday close). */
  trending(asOf: Date): Promise<Ticker[]>;
}

/** A fixed trending list (default: empty — inert until wired to a feed). */
export class StaticTrendingListProvider implements TrendingListProvider {
  private readonly tickers: readonly Ticker[];

  constructor(tickers: readonly Ticker[] = []) {
    this.tickers = [...tickers];
  }

  async trending(_asOf: Date): Promise<Ticker[]> {
    return [...this.tickers];
  }
}
