/**
 * Point-in-time market context for replay (T3.1). Identical to
 * `DbSimMarketContextProvider` except every candle/quote read is capped at the
 * replay clock's `now` (`ts <= now`). Without this cap a backtest would let a
 * strategy's `scan` see bars from *after* the moment it is deciding — lookahead
 * bias that inflates results and breaks the "replay ≡ live" guarantee. Open
 * positions still come from the in-process `Simulator`, which only knows bars
 * already fed to it, so it is point-in-time by construction.
 */
import { Inject, Injectable } from "@nestjs/common";
import { schema, and, desc, eq, lte } from "@magpie/db";
import {
  Simulator,
  type Candle,
  type CandleTimeframe,
  type ExecutionTarget,
  type MarketContext,
  type Position,
  type Quote,
  type Ticker,
} from "@magpie/core";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import { SIMULATOR } from "../pipeline/pipeline.providers.js";
import type { MarketContextProvider } from "../pipeline/pipeline.types.js";

@Injectable()
export class ReplayMarketContextProvider implements MarketContextProvider {
  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(SIMULATOR) private readonly simulator: Simulator,
  ) {}

  async contextFor(target: ExecutionTarget, now: Date): Promise<MarketContext> {
    const { db } = this.dbClient;
    const simulator = this.simulator;
    return {
      now,
      target,
      async candles(
        ticker: Ticker,
        timeframe: CandleTimeframe,
        limit = 200,
      ): Promise<Candle[]> {
        const rows = await db
          .select()
          .from(schema.candles)
          .where(
            and(
              eq(schema.candles.ticker, ticker),
              eq(schema.candles.timeframe, timeframe),
              // The one difference from the live provider: never look ahead.
              lte(schema.candles.ts, now),
            ),
          )
          .orderBy(desc(schema.candles.ts))
          .limit(limit);
        return rows.reverse().map((r) => ({
          ticker: r.ticker,
          timeframe: r.timeframe,
          ts: r.ts,
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: Number(r.volume),
        }));
      },
      async latestQuote(ticker: Ticker): Promise<Quote | null> {
        const [row] = await db
          .select()
          .from(schema.candles)
          .where(
            and(eq(schema.candles.ticker, ticker), lte(schema.candles.ts, now)),
          )
          .orderBy(desc(schema.candles.ts))
          .limit(1);
        if (!row) return null;
        const close = Number(row.close);
        return { ticker, bid: close, ask: close, last: close, ts: row.ts };
      },
      async accountEquity(strategyId: string): Promise<number> {
        // Backtests are always SIM: size against the strategy's virtual cash so
        // a replayed run's position sizes track its running P&L, like live SIM.
        return simulator.cash(strategyId);
      },
      async openPositions(strategyId?: string): Promise<Position[]> {
        return simulator.getPositions(strategyId);
      },
    };
  }
}
