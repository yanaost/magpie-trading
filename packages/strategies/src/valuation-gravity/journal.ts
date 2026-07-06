/**
 * Pure journaling logic for strategy #8 (valuation gravity, T2.8). Given the
 * watchlist, the recent earnings reports, and a P/S lookup, decide which names
 * are inside their two-week post-report window and emit one journal entry each.
 * No I/O, no clock — every rule is fixture-testable, and this is the only place
 * the strategy "does" anything (it never trades).
 */
import type { Ticker } from "@magpie/core";
import type { EarningsEvent } from "../earnings-fade/calendar.js";
import type { ValuationPair } from "./watchlist.js";

/** Tunable thresholds. */
export interface ValuationGravityParams {
  /** How many calendar days after a report to keep journaling it. */
  journalWindowDays: number;
}

export const DEFAULT_VALUATION_GRAVITY_PARAMS: ValuationGravityParams =
  Object.freeze({
    journalWindowDays: 14,
  });

/** One automatically-recorded post-earnings valuation observation. */
export interface ValuationJournalEntry {
  readonly strategyId: string;
  readonly ticker: Ticker;
  readonly peer: Ticker;
  /** Session this entry was written, ISO calendar date. */
  readonly asOf: string;
  /** The report this window follows, ISO calendar date. */
  readonly reportDate: string;
  /** Calendar days since the report (0 on the report date). */
  readonly daysSinceReport: number;
  /** Trailing P/S of the darling, or null when unavailable. */
  readonly priceToSales: number | null;
  /** Trailing P/S of the peer, or null when unavailable. */
  readonly peerPriceToSales: number | null;
  /**
   * How stretched the darling is vs its peer (its P/S ÷ the peer's), or null
   * when either multiple is missing. >1 = trading at a premium to the peer.
   */
  readonly psPremium: number | null;
  /** Human-readable summary for the journal feed. */
  readonly note: string;
}

/** Calendar days from `fromIso` (00:00Z) to `toIso` (00:00Z). */
function daysBetween(fromIso: string, toIso: string): number {
  const DAY = 86_400_000;
  const from = Date.parse(`${fromIso}T00:00:00.000Z`);
  const to = Date.parse(`${toIso}T00:00:00.000Z`);
  return Math.round((to - from) / DAY);
}

/** Round to 2dp, preserving null. */
function round2(n: number | null): number | null {
  return n === null ? null : Math.round(n * 100) / 100;
}

/**
 * Build the journal entries owed for `asOf`: one per watchlist name whose most
 * recent report is within `[0, journalWindowDays]` days of today. Pure — the
 * caller supplies the P/S readings so the function has no I/O.
 *
 * @param asOf - logical "now", ISO calendar date (YYYY-MM-DD)
 * @param strategyId - owning strategy id (stamped on each entry)
 * @param watchlist - the tracked darling/peer pairs
 * @param earnings - candidate reports (already watchlist-scoped is fine)
 * @param ps - a resolved P/S reading per ticker (self and peer)
 * @param params - window config
 */
export function buildJournalEntries(
  asOf: string,
  strategyId: string,
  watchlist: readonly ValuationPair[],
  earnings: readonly EarningsEvent[],
  ps: (ticker: Ticker) => number | null,
  params: ValuationGravityParams = DEFAULT_VALUATION_GRAVITY_PARAMS,
): ValuationJournalEntry[] {
  const byTicker = new Map<Ticker, ValuationPair>(
    watchlist.map((p) => [p.ticker, p]),
  );

  // Most recent in-window report per watchlist name (latest report ≤ asOf).
  const latest = new Map<Ticker, EarningsEvent>();
  for (const ev of earnings) {
    const pair = byTicker.get(ev.ticker);
    if (!pair) continue;
    const days = daysBetween(ev.reportDate, asOf);
    if (days < 0 || days > params.journalWindowDays) continue;
    const prev = latest.get(ev.ticker);
    if (!prev || ev.reportDate > prev.reportDate) latest.set(ev.ticker, ev);
  }

  const entries: ValuationJournalEntry[] = [];
  for (const [ticker, ev] of latest) {
    const pair = byTicker.get(ticker)!;
    const self = round2(ps(ticker));
    const peer = round2(ps(pair.peer));
    const psPremium =
      self !== null && peer !== null && peer > 0
        ? Math.round((self / peer) * 100) / 100
        : null;
    const daysSinceReport = daysBetween(ev.reportDate, asOf);
    entries.push({
      strategyId,
      ticker,
      peer: pair.peer,
      asOf,
      reportDate: ev.reportDate,
      daysSinceReport,
      priceToSales: self,
      peerPriceToSales: peer,
      psPremium,
      note: describe(ticker, pair.peer, self, peer, psPremium, daysSinceReport),
    });
  }
  // Stable order for deterministic replay.
  entries.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return entries;
}

function describe(
  ticker: Ticker,
  peer: Ticker,
  self: number | null,
  peerPs: number | null,
  premium: number | null,
  daysSinceReport: number,
): string {
  const wk = daysSinceReport <= 7 ? "week 1" : "week 2";
  if (self === null || peerPs === null || premium === null) {
    return `${ticker} post-earnings ${wk} (day ${daysSinceReport}): P/S vs ${peer} unavailable`;
  }
  const rel =
    premium > 1
      ? `${premium.toFixed(2)}× ${peer}'s multiple (premium)`
      : `${premium.toFixed(2)}× ${peer}'s multiple (discount)`;
  return `${ticker} post-earnings ${wk} (day ${daysSinceReport}): P/S ${self} vs ${peer} ${peerPs} — ${rel}`;
}
