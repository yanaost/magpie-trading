/**
 * Backtest service (T3.5) — runs strategy *variants* over a historical window
 * through the real money path and persists a comparable {@link BacktestReport}
 * per variant, for the variant-comparison tab.
 *
 * Each variant runs in complete isolation: its own {@link Simulator} (virtual
 * portfolio), its own variant-specific {@link PipelineService}, and a
 * point-in-time {@link ReplayMarketContextProvider} capped at the replay clock —
 * identical wiring to a live scan, so "replay ≡ live" holds. Persistence /
 * notification ports are no-ops here: a backtest must not write signals,
 * proposals, or journal rows into the live tables.
 *
 * The LLM step uses {@link ReplayLlmAnalyst} on an empty cache, so every analysis
 * is *replay-stubbed* and each report carries the visible `REPLAY_STUBBED`
 * caveat (spec §4.4: "backtest results are treated as directional").
 *
 * ## Pre-market universe
 * Snapback's universe is the pre-market gapper feed, which is not part of the
 * `candles` data model (market cap / pre-market price aren't stored). So the
 * caller supplies the gapper set to screen against; with none, the strategy has
 * no universe and reports zero trades (honest, not an error).
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  DEFAULT_RISK_PARAMS,
  RiskManager,
  Simulator,
  type CandleTimeframe,
  type ExecutionTarget,
} from "@magpie/core";
import {
  StaticPremarketScreener,
  buildVariantStrategy,
  snapbackWaitVariants,
  type PremarketGapper,
  type StrategyVariantSpec,
} from "@magpie/strategies";
import { DB_CLIENT, type DbClient } from "../infra/infra.module.js";
import { InMemoryBracketIndex } from "../pipeline/bracket-index.js";
import { PipelineService } from "../pipeline/pipeline.service.js";
import type {
  StrategyRegistry,
  StrategyRuntime,
} from "../pipeline/pipeline.types.js";
import { DbReplayBarSource } from "../replay/replay-bar-source.js";
import { ReplayClock } from "../replay/replay-clock.js";
import { ReplayMarketContextProvider } from "../replay/replay-market-context.provider.js";
import {
  NullAnalysisCache,
  ReplayLlmAnalyst,
} from "../replay/replay-analyst.js";
import {
  OutcomeTallyingPipeline,
  StubbingCountingAnalyst,
  runVariantBacktest,
  type BacktestRunResult,
} from "./backtest-runner.js";
import { BacktestReportStore } from "./backtest-report.store.js";

/** A backtest window + resolution. */
export interface BacktestWindow {
  readonly from: Date;
  readonly to: Date;
  readonly timeframe?: CandleTimeframe;
}

/** Inputs to a variant comparison. */
export interface ComparisonRequest {
  readonly strategyId: string;
  readonly variants: readonly StrategyVariantSpec[];
  readonly window: BacktestWindow;
  /** Pre-market gappers to screen against (snapback). */
  readonly gappers?: readonly PremarketGapper[];
}

/** No-op persistence/notify ports — a backtest never writes live tables. */
const NOOP_SIGNAL_STORE = {
  seq: 0,
  async persist() {
    this.seq += 1;
    return {
      id: `00000000-0000-0000-0000-00000000${String(this.seq).padStart(4, "0")}`,
    };
  },
};
const NOOP_PROPOSAL_STORE = {
  seq: 0,
  async persist() {
    this.seq += 1;
    return {
      id: `00000000-0000-4000-8000-00000000${String(this.seq).padStart(4, "0")}`,
    };
  },
  async markExecuted() {},
  async reject() {},
  async get() {
    return null;
  },
  async listPendingDetailed() {
    return [];
  },
  async listPending() {
    return [];
  },
  async expire() {},
};

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    private readonly store: BacktestReportStore,
  ) {}

  /**
   * Run every variant over the window, persist each report, and return them.
   * Variants run sequentially (each is a fast full-speed replay) so the shared
   * DB isn't hammered by parallel scans.
   */
  async runComparison(req: ComparisonRequest): Promise<BacktestRunResult[]> {
    const runs: BacktestRunResult[] = [];
    for (const variant of req.variants) {
      const run = await this.runVariant(variant, req);
      await this.store.save(run);
      runs.push(run);
      this.logger.log(
        `backtested ${variant.instanceId}: ${run.report.performance.trades} trades, ` +
          `${run.report.vetoStats.executed} executed, replayStubbed=${run.report.replayStubbed}`,
      );
    }
    return runs;
  }

  /** Convenience: the canonical snapback 30 vs 60-min wait comparison (§4.4). */
  async compareSnapbackWaits(
    strategyId: string,
    window: BacktestWindow,
    gappers: readonly PremarketGapper[] = [],
    waits: readonly number[] = [30, 60],
  ): Promise<BacktestRunResult[]> {
    return this.runComparison({
      strategyId,
      variants: snapbackWaitVariants([...waits]),
      window,
      gappers,
    });
  }

  /** Read the persisted comparison rows for a strategy. */
  async list(strategyId: string) {
    return this.store.listForStrategy(strategyId);
  }

  private async runVariant(
    variant: StrategyVariantSpec,
    req: ComparisonRequest,
  ): Promise<BacktestRunResult> {
    const sim = new Simulator();
    const screener = new StaticPremarketScreener([...(req.gappers ?? [])]);
    const strategy = buildVariantStrategy(variant, {
      premarketScreener: screener,
    });

    const runtime: StrategyRuntime = {
      strategy,
      mode: "AUTO",
      executionTarget: "SIM",
      riskManager: new RiskManager(DEFAULT_RISK_PARAMS),
    };
    const registry: StrategyRegistry = {
      async getRuntime(id) {
        return id === strategy.id ? runtime : undefined;
      },
      async all() {
        return [runtime];
      },
    };

    const clock = new ReplayClock(req.window.from);
    const marketCtx = new ReplayMarketContextProvider(this.dbClient, sim);
    // Empty cache → every analysis replay-stubbed → visible REPLAY_STUBBED caveat.
    const analyst = new StubbingCountingAnalyst(
      new ReplayLlmAnalyst(new NullAnalysisCache()),
    );

    const service = new PipelineService(
      registry,
      analyst,
      NOOP_SIGNAL_STORE as never,
      NOOP_PROPOSAL_STORE as never,
      { async persist() {} } as never,
      { async append() {} } as never,
      { async append() {} },
      { async proposalPending() {} },
      {
        async check() {
          return { crowded: false };
        },
      },
      marketCtx,
      { portFor: () => sim },
      {
        async isActive() {
          return false;
        },
      },
      new InMemoryBracketIndex(),
      clock,
      // No governor: unbraked AUTO; closed trades stay buffered for the drain.
    );

    const pipeline = new OutcomeTallyingPipeline(service);
    const source = new DbReplayBarSource(
      this.dbClient,
      req.window.timeframe ?? "5m",
    );

    return runVariantBacktest({
      variant,
      request: {
        strategyId: strategy.id,
        from: req.window.from,
        to: req.window.to,
        speed: 1,
      },
      clock,
      feed: { onBar: (b) => sim.onBar(b) },
      source,
      pipeline,
      analyst,
      sim,
    });
  }
}

/** Guard: the pipeline's SIM execution target constant, for callers. */
export const BACKTEST_TARGET: ExecutionTarget = "SIM";
