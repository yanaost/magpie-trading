/**
 * Environment providers that bind the pipeline's ports to real infrastructure
 * (T1.6). These wrap existing services (LLM analyst, kill switch, WS gateway)
 * and the in-process SIM {@link Simulator}. The market-context and execution
 * providers target the SIM rung only — the MVP's single execution target;
 * PAPER/LIVE rungs are added with the broker adapter later.
 */
import { Inject, Injectable } from "@nestjs/common";
import { schema, and, desc, eq } from "@magpie/db";
import {
  Simulator,
  type Candle,
  type CandleTimeframe,
  type ExecutionPort,
  type ExecutionTarget,
  type MarketContext,
  type Position,
  type Quote,
  type Ticker,
} from "@magpie/core";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import { KillSwitchService } from "../killswitch/killswitch.service.js";
import { LlmAnalystService } from "../llm/llm-analyst.service.js";
import { EventsGateway } from "../ws/events.gateway.js";
import type {
  Clock,
  ExecutionPortProvider,
  KillSwitchGate,
  LlmAnalyst,
  MarketContextProvider,
  ProposalNotifier,
} from "./pipeline.types.js";
import type { TradeProposal } from "@magpie/core";

/**
 * The set of strategy code instances the pipeline can run, keyed later by
 * `Strategy.id`. Empty until strategy #3 (QUAL/SPHB, T1.7) registers itself.
 */
export const STRATEGY_INSTANCES = Symbol("STRATEGY_INSTANCES");

/** The shared in-process SIM execution port (spec §4.4). */
export const SIMULATOR = Symbol("SIMULATOR");

/** Wall-clock; the only place real time enters the otherwise-pure pipeline. */
@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Adapts the trust-boundary {@link LlmAnalystService} to the pipeline port. */
@Injectable()
export class LlmAnalystAdapter implements LlmAnalyst {
  constructor(private readonly service: LlmAnalystService) {}
  analyze(request: Parameters<LlmAnalystService["analyze"]>[0]) {
    return this.service.analyze(request);
  }
}

/** Adapts {@link KillSwitchService} to the pipeline's read-only gate. */
@Injectable()
export class KillSwitchGateAdapter implements KillSwitchGate {
  constructor(private readonly killSwitch: KillSwitchService) {}
  isActive(): Promise<boolean> {
    return this.killSwitch.isActive();
  }
}

/** Notifies dashboards (and, later, Telegram) that a proposal needs approval. */
@Injectable()
export class WsProposalNotifier implements ProposalNotifier {
  constructor(private readonly gateway: EventsGateway) {}
  async proposalPending(
    proposal: TradeProposal & { id: string },
  ): Promise<void> {
    this.gateway.emitProposal({
      id: proposal.id,
      strategyId: proposal.strategyId,
      ticker: proposal.ticker,
      side: proposal.side,
      qty: proposal.qty,
      entry: proposal.entry,
      stop: proposal.stop,
      target: proposal.target ?? null,
      riskUsd: proposal.riskUsd,
      riskPct: proposal.riskPct,
      expiry: proposal.expiry.toISOString(),
    });
  }
}

/** Serves the single SIM {@link Simulator} for the SIM rung. */
@Injectable()
export class SimExecutionPortProvider implements ExecutionPortProvider {
  constructor(@Inject(SIMULATOR) private readonly simulator: Simulator) {}
  portFor(target: ExecutionTarget): ExecutionPort {
    if (target !== "SIM") {
      throw new Error(
        `no execution port for target ${target} (only SIM in the MVP)`,
      );
    }
    return this.simulator;
  }
}

/**
 * Builds a read-only {@link MarketContext} for a run: candles come from the
 * `candles` table, quotes from the latest stored candle close (the sim fill
 * model tolerates a null quote and falls back to last close), and open
 * positions from the SIM port. Account equity is the SIM starting cash — a
 * live-marked equity model lands with the execution/reconciliation work (T1.8).
 */
@Injectable()
export class DbSimMarketContextProvider implements MarketContextProvider {
  /** MVP account equity for risk sizing until the sim portfolio is marked. */
  private static readonly DEFAULT_EQUITY = 100_000;

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
            ),
          )
          .orderBy(desc(schema.candles.ts))
          .limit(limit);
        // Fetched newest→oldest for the limit; return oldest→newest.
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
          .where(eq(schema.candles.ticker, ticker))
          .orderBy(desc(schema.candles.ts))
          .limit(1);
        if (!row) return null;
        const close = Number(row.close);
        return { ticker, bid: close, ask: close, last: close, ts: row.ts };
      },
      async accountEquity(): Promise<number> {
        return DbSimMarketContextProvider.DEFAULT_EQUITY;
      },
      async openPositions(strategyId?: string): Promise<Position[]> {
        return simulator.getPositions(strategyId);
      },
    };
  }
}
