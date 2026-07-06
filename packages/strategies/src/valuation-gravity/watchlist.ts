/**
 * Watchlist + valuation-data port for strategy #8 (valuation gravity, T2.8).
 *
 * A deliberately tiny, WATCH-only strategy: it tracks a fixed shortlist of
 * "retail darling" names, each paired with a more established peer, and journals
 * how the darling's price-to-sales multiple sits relative to that peer in the
 * two weeks after every earnings report. There is no trade here — the point is
 * to accumulate a disciplined record of whether stretched multiples actually
 * revert ("valuation gravity"), so a future trading strategy can be built on
 * evidence rather than vibes.
 *
 * Valuation data (trailing P/S) is external, so it arrives through a small port
 * with a static default — deterministic and offline like every other provider.
 */
import type { Ticker } from "@magpie/core";

/** One watchlist name and the peer its multiple is judged against. */
export interface ValuationPair {
  /** The retail-darling symbol being tracked. */
  readonly ticker: Ticker;
  /** The more-established peer whose multiple is the gravity reference. */
  readonly peer: Ticker;
  /** Why these two are comparable (sector/business-model note). */
  readonly rationale: string;
}

/**
 * The five tracked retail darlings (spec §3, T2.8). Fixed config, not a scan —
 * this strategy never discovers new names, it journals these.
 */
export const VALUATION_WATCHLIST: readonly ValuationPair[] = Object.freeze([
  {
    ticker: "RIVN",
    peer: "TSLA",
    rationale: "EV maker vs the scaled EV leader",
  },
  {
    ticker: "HOOD",
    peer: "SCHW",
    rationale: "retail broker vs incumbent broker",
  },
  { ticker: "PLTR", peer: "SNOW", rationale: "data-platform software peers" },
  {
    ticker: "SOFI",
    peer: "ALLY",
    rationale: "fintech bank vs established digital bank",
  },
  {
    ticker: "AFRM",
    peer: "SYF",
    rationale: "BNPL lender vs consumer-credit incumbent",
  },
]);

/** Supplies a trailing price-to-sales multiple for a symbol. */
export interface ValuationDataProvider {
  /**
   * Trailing P/S for `ticker` as of `asOf`, or `null` when unknown.
   * @param ticker - the symbol to price
   * @param asOf - logical "now" for the run
   */
  priceToSales(ticker: Ticker, asOf: Date): Promise<number | null>;
}

/**
 * Fixture/config-backed valuation data: a fixed symbol→P/S map. Deterministic —
 * the registry default (empty until a real fundamentals feed is wired in) and
 * the map tests seed with historical multiples. Optionally varies the multiple
 * over time via a per-date override map for replay.
 */
export class StaticValuationDataProvider implements ValuationDataProvider {
  private readonly base: Record<string, number>;
  /** date(ISO) → (ticker → P/S) overrides, for time-varying replay. */
  private readonly byDate: Record<string, Record<string, number>>;

  constructor(
    base: Record<string, number> = {},
    byDate: Record<string, Record<string, number>> = {},
  ) {
    this.base = { ...base };
    this.byDate = byDate;
  }

  async priceToSales(ticker: Ticker, asOf: Date): Promise<number | null> {
    const day = asOf.toISOString().slice(0, 10);
    const override = this.byDate[day]?.[ticker];
    if (typeof override === "number") return override;
    const base = this.base[ticker];
    return typeof base === "number" ? base : null;
  }
}
