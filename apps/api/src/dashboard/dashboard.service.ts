import { Inject, Injectable } from "@nestjs/common";
import { schema } from "@trading-app/db";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";

export interface StrategySummary {
  id: string;
  name: string;
  timeframe: string;
  mode: string;
  target: string;
}

export interface CandleCount {
  ticker: string;
  timeframe: string;
  count: number;
}

/**
 * Read-only queries backing the dashboard (T0.6): the strategy roster and
 * per-ticker candle counts.
 */
@Injectable()
export class DashboardService {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}

  async strategies(): Promise<StrategySummary[]> {
    const rows = await this.dbClient.db
      .select({
        id: schema.strategies.id,
        name: schema.strategies.name,
        timeframe: schema.strategies.timeframe,
        mode: schema.strategies.mode,
        target: schema.strategies.target,
      })
      .from(schema.strategies)
      .orderBy(schema.strategies.name);
    return rows;
  }

  async candleCounts(): Promise<CandleCount[]> {
    // Aggregate is simplest via the raw client; counts are small integers.
    const rows = await this.dbClient.sql<
      { ticker: string; timeframe: string; count: number }[]
    >`
      select ticker, timeframe, count(*)::int as count
      from candles
      group by ticker, timeframe
      order by ticker, timeframe
    `;
    return rows.map((r) => ({
      ticker: r.ticker,
      timeframe: r.timeframe,
      count: r.count,
    }));
  }
}
