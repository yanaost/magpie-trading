/**
 * Structural types for the IB market-data adapter. These are intentionally
 * decoupled from `@stoqey/ib`'s own types so the parser and queue can be unit
 * tested without importing the native client (the adapter maps the raw
 * positional event args into these shapes at the edge — see `ib-connection.ts`).
 */

/** A candle row ready to upsert into the `candles` table. */
export interface CandleRow {
  ticker: string;
  /** Timeframe key stored verbatim in `candles.timeframe` (e.g. "1d", "5m"). */
  timeframe: string;
  ts: Date;
  /** Numeric columns are written as strings to preserve precision. */
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/**
 * A raw historical bar as emitted by `EventName.historicalData`:
 * `(reqId, date, open, high, low, close, volume, barCount, WAP, hasGaps)`.
 */
export interface RawHistoricalBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A raw realtime bar as emitted by `EventName.realtimeBar`:
 * `(reqId, time, open, high, low, close, volume, wap, count)`. `time` is a unix
 * timestamp in seconds.
 */
export interface RawRealtimeBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
