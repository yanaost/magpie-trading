import { Inject, Injectable } from "@nestjs/common";
import { schema, and, desc, eq } from "@magpie/db";
import { Simulator } from "@magpie/core";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import { SIMULATOR } from "../pipeline/pipeline.providers.js";

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

/** An open SIM position, with the entry-relative distance to its stop. */
export interface PositionView {
  strategyId: string;
  ticker: string;
  side: string;
  qty: number;
  avgEntryPrice: number;
  stopPrice: number | null;
  /** % the price must fall (long) / rise (short) from entry to hit the stop. */
  distanceToStopPct: number | null;
  openRiskUsd: number;
  openedAt: string;
}

/** A portfolio-bar rollup across all open SIM positions. */
export interface PortfolioSummary {
  openPositions: number;
  openRiskUsd: number;
  tickers: string[];
}

/** A journal / signal-log row for the dashboard. */
export interface JournalView {
  id: string;
  strategyId: string | null;
  entryType: string;
  refType: string | null;
  refId: string | null;
  title: string;
  body: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Read-only queries backing the dashboard (T0.6 + T1.9): the strategy roster,
 * candle counts, open SIM positions, the decision/signal log, and the journal.
 * Also owns the single mode/target mutation the control surface exposes.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(SIMULATOR) private readonly simulator: Simulator,
  ) {}

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

  /**
   * Update a strategy's operating mode and/or execution target and audit the
   * change. In Phase 1 any transition is allowed; promotion gates (≥N closed
   * trades per rung) land in T2.2. Returns the updated summary, or null if the
   * strategy does not exist.
   */
  async setStrategy(
    id: string,
    change: { mode?: string; target?: string },
    actor = "user",
  ): Promise<StrategySummary | null> {
    const [before] = await this.dbClient.db
      .select()
      .from(schema.strategies)
      .where(eq(schema.strategies.id, id))
      .limit(1);
    if (!before) return null;

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (change.mode !== undefined) set.mode = change.mode;
    if (change.target !== undefined) set.target = change.target;

    await this.dbClient.db
      .update(schema.strategies)
      .set(set)
      .where(eq(schema.strategies.id, id));

    await this.dbClient.db.insert(schema.auditLog).values({
      entityType: "strategy",
      entityId: id,
      action: "config_change",
      actor,
      before: { mode: before.mode, target: before.target },
      after: {
        mode: change.mode ?? before.mode,
        target: change.target ?? before.target,
      },
    });

    return {
      id: before.id,
      name: before.name,
      timeframe: before.timeframe,
      mode: change.mode ?? before.mode,
      target: change.target ?? before.target,
    };
  }

  /** Open SIM positions (live, from the Simulator) with distance-to-stop. */
  async openPositions(strategyId?: string): Promise<PositionView[]> {
    const positions = await this.simulator.getPositions(strategyId);
    return positions.map((p) => {
      const stop = p.stopPrice ?? null;
      const distanceToStopPct =
        stop === null
          ? null
          : p.side === "long"
            ? ((p.avgEntryPrice - stop) / p.avgEntryPrice) * 100
            : ((stop - p.avgEntryPrice) / p.avgEntryPrice) * 100;
      const openRiskUsd =
        stop === null ? 0 : p.qty * Math.abs(p.avgEntryPrice - stop);
      return {
        strategyId: p.strategyId,
        ticker: p.ticker,
        side: p.side,
        qty: p.qty,
        avgEntryPrice: p.avgEntryPrice,
        stopPrice: stop,
        distanceToStopPct:
          distanceToStopPct === null
            ? null
            : Math.round(distanceToStopPct * 100) / 100,
        openRiskUsd: Math.round(openRiskUsd * 100) / 100,
        openedAt: p.openedAt.toISOString(),
      };
    });
  }

  /** Portfolio-bar rollup across all open SIM positions. */
  async portfolio(): Promise<PortfolioSummary> {
    const positions = await this.openPositions();
    const openRiskUsd = positions.reduce((sum, p) => sum + p.openRiskUsd, 0);
    return {
      openPositions: positions.length,
      openRiskUsd: Math.round(openRiskUsd * 100) / 100,
      tickers: [...new Set(positions.map((p) => p.ticker))],
    };
  }

  /**
   * The decision/signal log: journal entries of type `decision` (LLM verdicts,
   * risk rejections, WATCH would-trades, approvals, exits) newest-first. This is
   * where veto reasons surface (§3.3 "signal log including veto reasons").
   */
  async signalLog(strategyId?: string, limit = 50): Promise<JournalView[]> {
    return this.queryJournal({ entryType: "decision", strategyId, limit });
  }

  /** The full journal (decisions + free-text notes), newest-first. */
  async journal(strategyId?: string, limit = 100): Promise<JournalView[]> {
    return this.queryJournal({ strategyId, limit });
  }

  private async queryJournal(opts: {
    entryType?: string;
    strategyId?: string;
    limit: number;
  }): Promise<JournalView[]> {
    const conditions = [];
    if (opts.entryType)
      conditions.push(
        eq(
          schema.journalEntries.entryType,
          opts.entryType as "decision" | "note",
        ),
      );
    if (opts.strategyId)
      conditions.push(eq(schema.journalEntries.strategyId, opts.strategyId));
    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const rows = await this.dbClient.db
      .select()
      .from(schema.journalEntries)
      .where(where)
      .orderBy(desc(schema.journalEntries.createdAt))
      .limit(opts.limit);

    return rows.map((r) => ({
      id: r.id,
      strategyId: r.strategyId,
      entryType: r.entryType,
      refType: r.refType,
      refId: r.refId,
      title: r.title,
      body: r.body,
      meta: r.meta,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
