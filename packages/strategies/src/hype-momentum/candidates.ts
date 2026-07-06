/**
 * Injected data sources for strategy #2 (hype momentum, T2.6).
 *
 * Both are behind interfaces so the strategy is fully deterministic under
 * fixtures — no network, no clock. In production these are wired to a
 * trending/most-bought feed and an earnings calendar respectively; the static
 * defaults keep offline/CI runs inert.
 */
import type { Ticker } from "@magpie/core";

/**
 * Supplies the watchlist of "hyped" names to scan on a given day — e.g. a
 * trending / most-bought / unusual-volume screen. Same shape as the earnings
 * calendar provider (T2.5): interface + static default.
 */
export interface HypeCandidateProvider {
  /** Tickers worth scanning for a volume-spike breakout as of `asOf`. */
  candidates(asOf: Date): Promise<Ticker[]>;
}

/** A fixed candidate list (default: empty — inert until wired to a feed). */
export class StaticHypeCandidateProvider implements HypeCandidateProvider {
  private readonly tickers: readonly Ticker[];

  constructor(tickers: readonly Ticker[] = []) {
    this.tickers = [...tickers];
  }

  async candidates(_asOf: Date): Promise<Ticker[]> {
    return [...this.tickers];
  }
}

/**
 * Supplies the next scheduled earnings date per ticker — the hard "exit before
 * any earnings date" rule needs forward-looking dates (the T2.5 calendar returns
 * *recent* reporters, so this is a separate concern).
 */
export interface EarningsSchedule {
  /** Next earnings date (ISO `YYYY-MM-DD`) on/after `asOf`, or null if unknown. */
  nextEarningsDate(ticker: Ticker, asOf: Date): string | null;
}

/** A fixed map of upcoming earnings dates (default: none known). */
export class StaticEarningsSchedule implements EarningsSchedule {
  private readonly dates: ReadonlyMap<Ticker, string>;

  constructor(dates: Record<string, string> = {}) {
    this.dates = new Map(Object.entries(dates));
  }

  nextEarningsDate(ticker: Ticker, asOf: Date): string | null {
    const date = this.dates.get(ticker);
    if (!date) return null;
    // Only report dates that are still upcoming as of the scan.
    return date >= asOf.toISOString().slice(0, 10) ? date : null;
  }
}
