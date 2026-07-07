import { Inject, Injectable, Optional } from "@nestjs/common";
import { schema, and, desc, eq } from "@magpie/db";
import {
  Simulator,
  computePerformance,
  emptyPerformance,
  EXECUTION_TARGETS,
  DEFAULT_PROPOSAL_TTL_MS,
  DEFAULT_AUTO_GOVERNOR_PARAMS,
  type ClosedTrade,
  type PerformanceStats,
  type StrategyMeta,
} from "@magpie/core";
import { buildStrategyMetaById } from "@magpie/strategies";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import { SIMULATOR } from "../pipeline/pipeline.providers.js";
import {
  evaluatePromotionGate,
  PromotionGateError,
} from "../promotion/promotion-gate.js";
import { EventsGateway } from "../ws/events.gateway.js";

export interface StrategySummary {
  id: string;
  name: string;
  timeframe: string;
  mode: string;
  target: string;
  /** Plain-language description & mechanics (spec §U2); null for unknown ids. */
  meta: StrategyMeta | null;
  /** How long an APPROVE proposal stays open before it expires, ms (spec §U4). */
  proposalTtlMs: number;
  /** AUTO daily trade cap shown in the switch-to-AUTO confirmation (spec §U4). */
  autoMaxTradesPerDay: number;
}

/**
 * Config values surfaced to the mode/target UI (spec §U4). Sourced from the core
 * defaults so the captions render from config, not hardcoded prose — change the
 * constant and the displayed text follows. TTL is global (no per-strategy
 * override is wired) and the AUTO governor runs one shared instance on the
 * defaults, so both are the same for every strategy today; kept per-summary so a
 * future per-strategy override flows through without an API-shape change.
 */
const STRATEGY_CONFIG = {
  proposalTtlMs: DEFAULT_PROPOSAL_TTL_MS,
  autoMaxTradesPerDay: DEFAULT_AUTO_GOVERNOR_PARAMS.maxTradesPerDay,
} as const;

/**
 * Static strategy metadata keyed by id, built once at module load (the roster is
 * fixed for the process lifetime). Covers all eight strategies incl. the filter.
 */
const STRATEGY_META_BY_ID = buildStrategyMetaById();

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

/** Per-strategy performance, broken out by execution target (§3.3). */
export interface PerformanceView {
  strategyId: string;
  byTarget: Record<string, PerformanceStats>;
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
    @Optional() private readonly events?: EventsGateway,
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
    return rows.map((r) => ({
      ...r,
      meta: STRATEGY_META_BY_ID[r.id] ?? null,
      ...STRATEGY_CONFIG,
    }));
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

    const summary: StrategySummary = {
      id: before.id,
      name: before.name,
      timeframe: before.timeframe,
      mode: change.mode ?? before.mode,
      target: change.target ?? before.target,
      meta: STRATEGY_META_BY_ID[before.id] ?? null,
      ...STRATEGY_CONFIG,
    };

    // Push the change so every open dashboard's state chips update live (§U3).
    this.events?.emitStrategies(summary);

    return summary;
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

  /**
   * Per-strategy performance module (§3.3): win rate, avg R, max drawdown and
   * the realized-PnL equity curve, computed from *closed* positions and split by
   * execution target (SIM/PAPER/LIVE) so a strategy's paper record is never
   * conflated with its sim record. Targets with no closed trades yet report the
   * empty stats rather than being omitted, so the UI can render a stable set of
   * panels.
   */
  async performance(strategyId: string): Promise<PerformanceView> {
    const rows = await this.dbClient.sql<
      {
        target: string;
        realized_pnl: string;
        qty: string;
        avg_entry_price: string;
        stop_price: string | null;
        closed_at: Date | null;
      }[]
    >`
      select target, realized_pnl, qty, avg_entry_price, stop_price, closed_at
      from positions
      where strategy_id = ${strategyId}
        and status = 'closed'
        and closed_at is not null
    `;

    const byTarget: Record<string, PerformanceStats> = {};
    for (const target of EXECUTION_TARGETS) {
      byTarget[target] = emptyPerformance();
    }
    const grouped = new Map<string, ClosedTrade[]>();
    for (const r of rows) {
      const trade: ClosedTrade = {
        realizedPnl: Number(r.realized_pnl),
        qty: Math.abs(Number(r.qty)),
        entryPrice: Number(r.avg_entry_price),
        ...(r.stop_price === null ? {} : { stopPrice: Number(r.stop_price) }),
        // closed_at is guaranteed non-null by the query filter.
        closedAt: new Date(r.closed_at as Date),
      };
      const list = grouped.get(r.target) ?? [];
      list.push(trade);
      grouped.set(r.target, list);
    }
    for (const [target, trades] of grouped) {
      byTarget[target] = computePerformance(trades);
    }
    return { strategyId, byTarget };
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
