/**
 * Trading-week calendar helpers for strategy #7 (Friday→Monday flow, T2.7).
 *
 * The strategy only scans on the *last* trading session of a week and only
 * manages the Monday-weakness auto-cancel on the *first* trading session of the
 * next week. A plain "is it Friday?" check is wrong around market holidays and
 * half-days: on a Good-Friday week the close session is Thursday; after a Monday
 * holiday the open session is Tuesday; a half-day (e.g. the day after
 * Thanksgiving) is still a full session for boundary purposes. So week
 * boundaries are derived from an injected holiday set, not the weekday alone.
 *
 * Pure and clock-free — everything is fixture-testable (AC: "calendar-edge tests
 * incl. holidays, half days").
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO calendar date (YYYY-MM-DD) of a date's UTC day. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * A US-equity-style trading calendar: weekends plus an injected set of full
 * holidays are non-trading. Half-days trade normally (they are still sessions),
 * so they only need listing when a caller cares that they are shortened.
 */
export class TradingCalendar {
  private readonly holidays: ReadonlySet<string>;
  private readonly halfDays: ReadonlySet<string>;

  constructor(
    holidays: Iterable<string> = [],
    halfDays: Iterable<string> = [],
  ) {
    this.holidays = new Set(holidays);
    this.halfDays = new Set(halfDays);
  }

  /** Weekday and not a listed holiday. Half-days count as trading days. */
  isTradingDay(d: Date): boolean {
    const dow = d.getUTCDay(); // 0=Sun … 6=Sat
    if (dow === 0 || dow === 6) return false;
    return !this.holidays.has(isoDate(d));
  }

  /** Whether `d` is a shortened (half) session. */
  isHalfDay(d: Date): boolean {
    return this.halfDays.has(isoDate(d));
  }

  /** The next trading day strictly after `d` (scans forward, weekends/holidays skipped). */
  nextTradingDay(d: Date): Date {
    let cur = new Date(d.getTime() + DAY_MS);
    // Bounded: at most a week of consecutive non-trading days.
    for (let i = 0; i < 10 && !this.isTradingDay(cur); i++) {
      cur = new Date(cur.getTime() + DAY_MS);
    }
    return cur;
  }

  /** The previous trading day strictly before `d`. */
  prevTradingDay(d: Date): Date {
    let cur = new Date(d.getTime() - DAY_MS);
    for (let i = 0; i < 10 && !this.isTradingDay(cur); i++) {
      cur = new Date(cur.getTime() - DAY_MS);
    }
    return cur;
  }

  /** Last trading session of `d`'s week — i.e. the next trading day is a new week. */
  isWeekCloseSession(d: Date): boolean {
    if (!this.isTradingDay(d)) return false;
    return weekKey(this.nextTradingDay(d)) !== weekKey(d);
  }

  /** First trading session of `d`'s week — i.e. the previous trading day was last week. */
  isWeekOpenSession(d: Date): boolean {
    if (!this.isTradingDay(d)) return false;
    return weekKey(this.prevTradingDay(d)) !== weekKey(d);
  }
}

/**
 * A week identifier: the ISO date of the Monday of `d`'s week (UTC). Two dates
 * share a week iff they share a Monday, which is all the boundary checks need.
 */
export function weekKey(d: Date): string {
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const backToMonday = (dow + 6) % 7; // Mon→0, Sun→6
  const monday = new Date(d.getTime() - backToMonday * DAY_MS);
  return isoDate(monday);
}
