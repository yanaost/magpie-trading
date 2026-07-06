/**
 * Earnings-calendar port for strategy #1 (earnings fade, T2.5).
 *
 * The strategy needs to know which watchlist names reported earnings in the last
 * few sessions so it can look for a post-report bounce-stall. That calendar is
 * external data, so it comes through this small port — a real adapter (a free
 * earnings-calendar API) in production, a {@link StaticCalendarProvider} seeded
 * from fixtures in tests and dry runs. Keeping it behind an interface is what
 * lets the whole strategy be exercised deterministically without a network.
 */
import type { Ticker } from "@magpie/core";

/** One company's earnings report on the calendar. */
export interface EarningsEvent {
  /** Reporting symbol. */
  readonly ticker: Ticker;
  /** Session the company reported, as an ISO calendar date (YYYY-MM-DD). */
  readonly reportDate: string;
  /** When in the session it reported, when known. */
  readonly timing?: "bmo" | "amc" | "unknown";
}

/** Supplies the recent earnings reports the strategy should evaluate. */
export interface CalendarProvider {
  /**
   * Reports on the (already watchlist-filtered) calendar within the lookback
   * window ending at `asOf`. Implementations decide the window; the strategy
   * only fades names that reported a few sessions ago.
   * @param asOf - logical "now" for the run
   */
  recentEarnings(asOf: Date): Promise<EarningsEvent[]>;
}

/**
 * Fixture/config-backed provider: returns a fixed event list, optionally
 * filtered to a watchlist. Deterministic — the default the registry constructs
 * with (empty until real calendar data is wired in) and the one tests seed with
 * a real historical earnings week.
 */
export class StaticCalendarProvider implements CalendarProvider {
  private readonly events: readonly EarningsEvent[];

  constructor(
    events: readonly EarningsEvent[] = [],
    watchlist?: readonly Ticker[],
  ) {
    const allow = watchlist ? new Set(watchlist) : null;
    this.events = allow
      ? events.filter((e) => allow.has(e.ticker))
      : [...events];
  }

  async recentEarnings(): Promise<EarningsEvent[]> {
    return [...this.events];
  }
}
