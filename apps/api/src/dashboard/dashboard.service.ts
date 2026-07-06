import { Inject, Injectable } from "@nestjs/common";
import { schema, and, desc, eq } from "@magpie/db";
import { Simulator } from "@magpie/core";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import { SIMULATOR } from "../pipeline/pipeline.providers.js";
import {
  evaluatePromotionGate,
  PromotionGateError,
} from "../promotion/promotion-gate.js";

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
   * change. A target *promotion* (SIM→PAPER→LIVE) must clear the promotion gate
   * (T2.2): ≥{@link PROMOTION_MIN_CLOSED_TRADES} closed trades at the current
   * rung plus an attached review note; demotions and mode-only changes are
   * always allowed. Returns the updated summary, or null if the strategy does
   * not exist. Throws {@link PromotionGateError} on a blocked promotion.
   */
  async setStrategy(
    id: string,
    change: { mode?: string; target?: string; note?: string },
    actor = "user",
  ): Promise<StrategySummary | null> {
    const [before] = await this.dbClient.db
      .select()
      .from(schema.strategies)
      .where(eq(schema.strategies.id, id))
      .limit(1);
    if (!before) return null;

    // Gate a target change before touching the row.
    if (change.target !== undefined && change.target !== before.target) {
      const closedTrades = await this.countClosedTrades(id, before.target);
      const decision = evaluatePromotionGate({
        from: before.target,
        to: change.target,
        closedTrades,
        note: change.note,
      });
      if (!decision.allowed) {
        // "All audited" — record the refused attempt before rejecting.
        await this.dbClient.db.insert(schema.auditLog).values({
          entityType: "strategy",
          entityId: id,
          action: "promotion_rejected",
          actor,
          before: { target: before.target },
          after: {
            target: change.target,
            code: decision.code,
            reason: decision.reason,
            closedTrades,
          },
        });
        throw new PromotionGateError(
          decision.code ?? "INSUFFICIENT_TRADES",
          decision.reason ?? "promotion rejected",
        );
      }
    }

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
        ...(change.note ? { note: change.note } : {}),
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

  /** Count closed trades a strategy has completed at a given execution rung. */
  private async countClosedTrades(
    strategyId: string,
    target: string,
  ): Promise<number> {
    const rows = await this.dbClient.sql<{ n: number }[]>`
      select count(*)::int as n
      from positions
      where strategy_id = ${strategyId}
        and target = ${target}
        and status = 'closed'
    `;
    return rows[0]?.n ?? 0;
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
