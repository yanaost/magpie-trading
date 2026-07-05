/**
 * Market-data value types and the read-only market context handed to every
 * strategy's `universe`/`scan`/`manage` calls (spec §3.1, §4). Prices and
 * volumes are plain `number`s here — the money path does arithmetic on them and
 * rounds deliberately (see `roundCents`); the repository layer converts the
 * DB's numeric-strings at the boundary. The LLM never sees these values.
 */
import { z } from "zod";
import type { ExecutionTarget } from "./enums.js";
import type { Position } from "./position.js";

/** A tradable symbol, e.g. "QUAL". Uppercase alphanumerics, dots and dashes. */
export const TickerSchema = z
  .string()
  .min(1)
  .max(12)
  .regex(/^[A-Z0-9.-]+$/, "ticker must be uppercase symbol characters");
/** A tradable symbol string (branded only nominally; it is a plain string). */
export type Ticker = z.infer<typeof TickerSchema>;

/**
 * Candle store granularity as persisted in `candles.timeframe`
 * (e.g. "1d", "5m", "1w"). Kept as a string union of the common values but the
 * schema accepts any non-empty string so new granularities need no code change.
 */
export const CandleTimeframeSchema = z.string().min(1);
/** Candle granularity key (market-data timeframe, distinct from strategy kind). */
export type CandleTimeframe = z.infer<typeof CandleTimeframeSchema>;

/** One OHLCV bar. `ts` is the bar's open time (UTC). */
export const CandleSchema = z.object({
  /** Symbol this bar belongs to. */
  ticker: TickerSchema,
  /** Granularity key, e.g. "1d" or "5m". */
  timeframe: CandleTimeframeSchema,
  /** Bar open time (UTC). Accepts a Date or an ISO string at the boundary. */
  ts: z.coerce.date(),
  /** Open price. */
  open: z.number().finite(),
  /** High price. */
  high: z.number().finite(),
  /** Low price. */
  low: z.number().finite(),
  /** Close price. */
  close: z.number().finite(),
  /** Traded volume over the bar. */
  volume: z.number().finite().nonnegative(),
});
/** One OHLCV bar (computation-friendly form of a `candles` row). */
export type Candle = z.infer<typeof CandleSchema>;

/** A point-in-time top-of-book quote used by the sim fill model (spec §4.4). */
export const QuoteSchema = z.object({
  /** Symbol quoted. */
  ticker: TickerSchema,
  /** Best bid, if known. */
  bid: z.number().finite().nonnegative().nullable(),
  /** Best ask, if known. */
  ask: z.number().finite().nonnegative().nullable(),
  /** Last trade price, if known. */
  last: z.number().finite().nonnegative().nullable(),
  /** Quote timestamp (UTC). */
  ts: z.coerce.date(),
});
/** A top-of-book quote snapshot. */
export type Quote = z.infer<typeof QuoteSchema>;

/**
 * Read-only view of the market and account handed to a strategy on each run.
 * This is an in-process behavioral interface (methods, not a serialized
 * payload), so it has no zod schema. Implementations back it with the candle
 * store, the market-data adapter, and the positions repository.
 */
export interface MarketContext {
  /** Logical "now" for this run — real time live, simulated time in replay. */
  readonly now: Date;
  /** Which rung this run targets; lets a strategy branch on SIM vs PAPER. */
  readonly target: ExecutionTarget;
  /**
   * Recent candles for a symbol, oldest→newest, capped at `limit` bars.
   * @param ticker - symbol to fetch
   * @param timeframe - granularity key (e.g. "1d")
   * @param limit - max bars to return (most recent)
   */
  candles(
    ticker: Ticker,
    timeframe: CandleTimeframe,
    limit?: number,
  ): Promise<Candle[]>;
  /**
   * Latest quote for a symbol, or `null` when no quote is available (after
   * hours, missing subscription). The sim fill model falls back to last close.
   */
  latestQuote(ticker: Ticker): Promise<Quote | null>;
  /** Current account equity in account currency (USD), used for risk sizing. */
  accountEquity(): Promise<number>;
  /**
   * Currently open positions, optionally filtered to one strategy.
   * @param strategyId - when given, only this strategy's positions
   */
  openPositions(strategyId?: string): Promise<Position[]>;
}
