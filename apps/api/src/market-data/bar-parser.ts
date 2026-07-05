import type { CandleRow, RawHistoricalBar, RawRealtimeBar } from "./types.js";

/**
 * Pure parsing of IB bar payloads into {@link CandleRow}s. No I/O, no client
 * dependency — this is the path exercised by the recorded-fixture test so the
 * parsing is proven off market hours (T0.5 AC).
 */

/** The historical-data stream terminates with a `finished-…` sentinel date. */
export function isHistoricalEnd(bar: Pick<RawHistoricalBar, "date">): boolean {
  return typeof bar.date === "string" && bar.date.startsWith("finished");
}

/** True when every OHLC field is a finite, sane number. */
function hasValidOhlc(
  bar: Pick<RawHistoricalBar, "open" | "high" | "low" | "close">,
): boolean {
  const nums = [bar.open, bar.high, bar.low, bar.close];
  return nums.every(
    (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
  );
}

/**
 * Parse an IB date field into a UTC `Date`.
 *
 * IB returns one of three shapes depending on `formatDate` and bar size:
 *  - `"YYYYMMDD"` (daily bars, `formatDate=1`) → UTC midnight of that day.
 *  - `"YYYYMMDD  HH:mm:ss"` (intraday, `formatDate=1`) → parsed as UTC.
 *  - epoch seconds as a string (`formatDate=2`) → converted directly.
 *
 * We request `formatDate=2` for determinism, but all shapes are handled so the
 * parser is robust across IB/TWS versions. Returns `null` if unparseable.
 */
export function parseIbDate(raw: string): Date | null {
  const value = raw.trim();
  if (value === "") return null;

  // Pure-digit, 8 chars → YYYYMMDD calendar date.
  if (/^\d{8}$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6));
    const day = Number(value.slice(6, 8));
    const ms = Date.UTC(year, month - 1, day);
    return Number.isNaN(ms) ? null : new Date(ms);
  }

  // Pure-digit, other length → epoch seconds.
  if (/^\d+$/.test(value)) {
    const secs = Number(value);
    return Number.isFinite(secs) ? new Date(secs * 1000) : null;
  }

  // "YYYYMMDD  HH:mm:ss" (one or more spaces) → treat components as UTC.
  const match = /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    const ms = Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
    );
    return Number.isNaN(ms) ? null : new Date(ms);
  }

  return null;
}

/**
 * Convert a raw historical bar into a {@link CandleRow}. Returns `null` for the
 * stream sentinel, an unparseable date, or an invalid OHLC set (so bad rows are
 * dropped rather than written).
 */
export function parseHistoricalBar(
  bar: RawHistoricalBar,
  ctx: { ticker: string; timeframe: string },
): CandleRow | null {
  if (isHistoricalEnd(bar)) return null;
  if (!hasValidOhlc(bar)) return null;
  const ts = parseIbDate(bar.date);
  if (ts === null) return null;

  const volume =
    Number.isFinite(bar.volume) && bar.volume >= 0 ? bar.volume : 0;
  return {
    ticker: ctx.ticker,
    timeframe: ctx.timeframe,
    ts,
    open: String(bar.open),
    high: String(bar.high),
    low: String(bar.low),
    close: String(bar.close),
    volume: String(volume),
  };
}

/**
 * Convert a raw realtime (5-second) bar into a {@link CandleRow}. `time` is a
 * unix timestamp in seconds. Returns `null` on invalid OHLC or timestamp.
 */
export function parseRealtimeBar(
  bar: RawRealtimeBar,
  ctx: { ticker: string; timeframe: string },
): CandleRow | null {
  if (!hasValidOhlc(bar)) return null;
  if (typeof bar.time !== "number" || !Number.isFinite(bar.time)) return null;

  const volume =
    Number.isFinite(bar.volume) && bar.volume >= 0 ? bar.volume : 0;
  return {
    ticker: ctx.ticker,
    timeframe: ctx.timeframe,
    ts: new Date(bar.time * 1000),
    open: String(bar.open),
    high: String(bar.high),
    low: String(bar.low),
    close: String(bar.close),
    volume: String(volume),
  };
}
