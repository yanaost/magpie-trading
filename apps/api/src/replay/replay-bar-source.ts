/**
 * DB-backed {@link ReplayBarSource} (T3.1) — reads historical candles for a
 * window from the `candles` table, oldest→newest. The engine re-sorts and
 * groups them, so this only has to return the window; a tighter `timeframe`
 * filter keeps intraday replays from pulling daily bars.
 */
import { Inject, Injectable } from "@nestjs/common";
import { schema, and, asc, eq, gte, lte } from "@magpie/db";
import type { Candle, CandleTimeframe } from "@magpie/core";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import type { ReplayBarSource } from "./replay-engine.js";

@Injectable()
export class DbReplayBarSource implements ReplayBarSource {
  /**
   * @param dbClient - Drizzle client
   * @param timeframe - which candle resolution to replay (e.g. "5m", "1d")
   */
  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    private readonly timeframe: CandleTimeframe = "5m",
  ) {}

  async bars(from: Date, to: Date): Promise<readonly Candle[]> {
    const rows = await this.dbClient.db
      .select()
      .from(schema.candles)
      .where(
        and(
          eq(schema.candles.timeframe, this.timeframe),
          gte(schema.candles.ts, from),
          lte(schema.candles.ts, to),
        ),
      )
      .orderBy(asc(schema.candles.ts));
    return rows.map((r) => ({
      ticker: r.ticker,
      timeframe: r.timeframe,
      ts: r.ts,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));
  }
}
