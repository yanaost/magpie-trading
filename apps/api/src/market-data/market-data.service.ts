import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { schema, sql } from "@trading-app/db";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import { parseHistoricalBar, parseRealtimeBar } from "./bar-parser.js";
import { IbConnection, type IbClientFactory } from "./ib-connection.js";
import { createIbClient } from "./ib-client-factory.js";
import { PacingQueue } from "./pacing-queue.js";
import type { CandleRow, RawHistoricalBar } from "./types.js";

/** A US stock contract for SMART routing (all roster tickers are US equities). */
function stockContract(ticker: string): Record<string, unknown> {
  return {
    symbol: ticker,
    secType: "STK",
    exchange: "SMART",
    currency: "USD",
  };
}

interface TimeframeSpec {
  /** Value stored in `candles.timeframe`. */
  key: string;
  /** IB `BarSizeSetting` string. */
  barSize: string;
  /** Build the IB duration string for a requested number of days. */
  duration: (days: number) => string;
}

const DAILY: TimeframeSpec = {
  key: "1d",
  barSize: "1 day",
  duration: (days) =>
    days > 365 ? `${Math.ceil(days / 365)} Y` : `${Math.max(1, days)} D`,
};

const FIVE_MIN: TimeframeSpec = {
  // IB caps intraday history per request; bound the window for 5-min bars.
  key: "5m",
  barSize: "5 mins",
  duration: (days) => `${Math.min(Math.max(1, days), 10)} D`,
};

/** Realtime bars stream as 5-second bars; stored under this timeframe key. */
const REALTIME_TF = "5s";

interface PendingHistorical {
  rows: CandleRow[];
  ctx: { ticker: string; timeframe: string };
  resolve: (rows: CandleRow[]) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const HISTORICAL_TIMEOUT_MS = 60_000;

/**
 * IB market-data adapter: connects to the gateway, backfills historical candles
 * (rate-limited to respect IB pacing), and — during market hours — subscribes to
 * realtime bars and persists them. Usable both inside Nest (live subscription)
 * and standalone from the backfill CLI (`new MarketDataService(...)`).
 */
@Injectable()
export class MarketDataService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("MarketDataService");
  private readonly connection: IbConnection;
  private readonly queue: PacingQueue;
  private readonly pending = new Map<number, PendingHistorical>();
  private readonly realtimeReqs = new Map<number, string>(); // reqId → ticker
  private reqSeq = 1;
  private lastBarAt: Date | null = null;
  private wired = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Optional() factory: IbClientFactory = createIbClient,
  ) {
    this.connection = new IbConnection({
      host: config.IB_GATEWAY_HOST,
      port: config.IB_GATEWAY_PORT,
      clientId: config.IB_CLIENT_ID,
      baseReconnectMs: config.IB_RECONNECT_BASE_MS,
      maxReconnectMs: config.IB_RECONNECT_MAX_MS,
      factory,
      logger: {
        log: (m) => this.logger.log(m),
        warn: (m) => this.logger.warn(m),
        error: (m) => this.logger.error(m),
      },
    });
    this.queue = new PacingQueue({
      minIntervalMs: config.IB_PACING_INTERVAL_MS,
      maxRetries: 5,
      baseBackoffMs: 2_000,
      maxBackoffMs: 60_000,
      onEvent: (e) => this.logger.debug?.(`[pacing] ${JSON.stringify(e)}`),
    });
    this.wire();
  }

  onModuleInit(): void {
    if (!this.config.MARKET_DATA_ENABLED) {
      this.logger.log("market data disabled (MARKET_DATA_ENABLED=false)");
      return;
    }
    this.connection.on("connected", () => this.subscribeConfiguredTickers());
    this.connect();
  }

  onModuleDestroy(): void {
    this.connection.stop();
  }

  /** Open the connection (non-blocking; reconnect handled internally). */
  connect(): void {
    this.connection.start();
  }

  disconnect(): void {
    this.connection.stop();
  }

  isConnected(): boolean {
    return this.connection.isConnected();
  }

  /** Resolve once the gateway connection is established, or reject on timeout. */
  waitUntilConnected(timeoutMs = 20_000): Promise<void> {
    if (this.connection.isConnected()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onConnected = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.connection.off("connected", onConnected);
        reject(new Error("timed out waiting for IB gateway connection"));
      }, timeoutMs);
      this.connection.once("connected", onConnected);
    });
  }

  /** Timestamp of the most recent realtime bar seen (for health/dashboard). */
  lastBarSeenAt(): Date | null {
    return this.lastBarAt;
  }

  /** Wire IbConnection events to the pending-request router and realtime writer. */
  private wire(): void {
    if (this.wired) return;
    this.wired = true;

    this.connection.on(
      "historicalData",
      (reqId: number, bar: RawHistoricalBar) => {
        const req = this.pending.get(reqId);
        if (!req) return;
        const row = parseHistoricalBar(bar, req.ctx);
        if (row) req.rows.push(row);
      },
    );

    this.connection.on("historicalEnd", (reqId: number) => {
      const req = this.pending.get(reqId);
      if (!req) return;
      clearTimeout(req.timer);
      this.pending.delete(reqId);
      req.resolve(req.rows);
    });

    this.connection.on(
      "error",
      (err: { code?: number; message?: string; reqId?: number }) => {
        if (err.reqId === undefined) return;
        const req = this.pending.get(err.reqId);
        if (!req) return;
        clearTimeout(req.timer);
        this.pending.delete(err.reqId);
        req.reject(err);
      },
    );

    this.connection.on(
      "realtimeBar",
      (reqId: number, bar: Parameters<typeof parseRealtimeBar>[0]) => {
        const ticker = this.realtimeReqs.get(reqId);
        if (!ticker) return;
        const row = parseRealtimeBar(bar, {
          ticker,
          timeframe: REALTIME_TF,
        });
        if (!row) return;
        this.lastBarAt = row.ts;
        void this.writeCandles([row]).catch((e) =>
          this.logger.error(`realtime write failed: ${String(e)}`),
        );
      },
    );
  }

  /**
   * Backfill historical daily + 5-minute candles for the given tickers. Every
   * request goes through the pacing queue. Resolves with the total row count.
   */
  async backfill(tickers: string[], days: number): Promise<number> {
    let total = 0;
    for (const ticker of tickers) {
      for (const spec of [DAILY, FIVE_MIN]) {
        try {
          const rows = await this.fetchHistorical(ticker, spec, days);
          const written = await this.writeCandles(rows);
          total += written;
          this.logger.log(`backfill ${ticker} ${spec.key}: ${written} candles`);
        } catch (err) {
          this.logger.error(
            `backfill ${ticker} ${spec.key} failed: ${String(err)}`,
          );
        }
      }
    }
    return total;
  }

  /** Issue a single historical request (through the pacing queue) and collect
   * its bars until the stream completes. */
  private fetchHistorical(
    ticker: string,
    spec: TimeframeSpec,
    days: number,
  ): Promise<CandleRow[]> {
    return this.queue.enqueue(
      () =>
        new Promise<CandleRow[]>((resolve, reject) => {
          const client = this.connection.raw();
          if (!client || !this.connection.isConnected()) {
            reject(new Error("IB gateway not connected"));
            return;
          }
          const reqId = this.nextReqId();
          const timer = setTimeout(() => {
            this.pending.delete(reqId);
            reject(new Error(`historical request ${reqId} timed out`));
          }, HISTORICAL_TIMEOUT_MS);
          this.pending.set(reqId, {
            rows: [],
            ctx: { ticker, timeframe: spec.key },
            resolve,
            reject,
            timer,
          });
          client.reqHistoricalData(
            reqId,
            stockContract(ticker),
            "",
            spec.duration(days),
            spec.barSize,
            "TRADES",
            1, // useRTH
            2, // formatDate: epoch seconds
            false, // keepUpToDate
          );
        }),
      `${ticker}:${spec.key}`,
    );
  }

  /** Subscribe realtime 5-second bars for every configured ticker. */
  private subscribeConfiguredTickers(): void {
    const client = this.connection.raw();
    if (!client) return;
    for (const ticker of this.tickers()) {
      const reqId = this.nextReqId();
      this.realtimeReqs.set(reqId, ticker);
      try {
        client.reqRealTimeBars(reqId, stockContract(ticker), 5, "TRADES", true);
        this.logger.log(`subscribed realtime bars: ${ticker} (req ${reqId})`);
      } catch (err) {
        this.logger.error(`subscribe ${ticker} failed: ${String(err)}`);
      }
    }
  }

  /** Upsert candle rows (idempotent on the composite primary key). */
  async writeCandles(rows: CandleRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    await this.dbClient.db
      .insert(schema.candles)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          schema.candles.ticker,
          schema.candles.timeframe,
          schema.candles.ts,
        ],
        set: {
          open: sqlExcluded("open"),
          high: sqlExcluded("high"),
          low: sqlExcluded("low"),
          close: sqlExcluded("close"),
          volume: sqlExcluded("volume"),
        },
      });
    return rows.length;
  }

  private tickers(): string[] {
    return this.config.MARKET_DATA_TICKERS.split(",")
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length > 0);
  }

  private nextReqId(): number {
    return this.reqSeq++;
  }
}

/** `excluded.<col>` reference for an upsert SET clause. */
function sqlExcluded(column: string) {
  // drizzle exposes the conflicting row as `excluded`.
  return sql.raw(`excluded.${column}`);
}
