/**
 * Backtest runner (T3.5) — drives the {@link ReplayEngine} for one strategy
 * variant over a historical window at full speed and reduces the run to a
 * {@link BacktestReport} (the §4.4 artifact).
 *
 * The runner owns no money-path logic; it composes existing pieces and tallies:
 *
 *   - the *live* {@link ReplayEngine} + pipeline run the variant exactly as
 *     production would (identical scan → LLM → crowding → risk → execute path);
 *   - {@link OutcomeTallyingPipeline} decorates the pipeline to capture every
 *     scan outcome (for the per-rule veto stats);
 *   - {@link StubbingCountingAnalyst} decorates the LLM analyst to count how many
 *     analyses were replay-stubbed (for the visible `REPLAY_STUBBED` caveat);
 *   - closed trades are drained from the run's {@link Simulator} and reduced by
 *     the pure core report math.
 *
 * Every collaborator is passed in, so the runner is unit-testable with a real
 * Simulator + real strategy and no Nest DI or Postgres.
 */
import type {
  AnalysisRequest,
  BacktestReport,
  LLMAnalysis,
  Simulator,
} from "@magpie/core";
import { buildBacktestReport, simTradesToClosedTrades } from "@magpie/core";
import type { StrategyVariantSpec } from "@magpie/strategies";
import {
  NoopPacer,
  ReplayEngine,
  type ReplayBarSource,
  type ReplayFeed,
  type ReplayPacer,
  type ReplayPipeline,
  type ReplayRequest,
  type SettableClock,
} from "../replay/replay-engine.js";
import type { LlmAnalyst } from "../pipeline/pipeline.types.js";

/** The one discriminant the report math needs off a pipeline scan outcome. */
export interface OutcomeLike {
  readonly kind: string;
}

/** A pipeline whose scan surfaces its per-signal outcomes (PipelineService). */
export interface ScanningPipeline {
  monitorPositions(strategyId: string): Promise<unknown>;
  runScan(strategyId: string): Promise<readonly OutcomeLike[]>;
  sweepExpiredProposals(): Promise<unknown>;
}

/**
 * Adapts a {@link ScanningPipeline} to the engine's {@link ReplayPipeline},
 * accumulating every scan outcome across the run for the veto-stats tally.
 */
export class OutcomeTallyingPipeline implements ReplayPipeline {
  readonly outcomes: OutcomeLike[] = [];

  constructor(private readonly inner: ScanningPipeline) {}

  monitorPositions(strategyId: string): Promise<unknown> {
    return this.inner.monitorPositions(strategyId);
  }

  async runScan(strategyId: string): Promise<unknown> {
    const outcomes = await this.inner.runScan(strategyId);
    this.outcomes.push(...outcomes);
    return outcomes;
  }

  sweepExpiredProposals(): Promise<unknown> {
    return this.inner.sweepExpiredProposals();
  }
}

/** Decorates an analyst to count total + replay-stubbed analyses. */
export class StubbingCountingAnalyst implements LlmAnalyst {
  analyses = 0;
  stubbed = 0;

  constructor(private readonly inner: LlmAnalyst) {}

  async analyze(request: AnalysisRequest): Promise<LLMAnalysis> {
    const analysis = await this.inner.analyze(request);
    this.analyses += 1;
    if (analysis.replayStubbed) this.stubbed += 1;
    return analysis;
  }
}

/** Identity + window of a completed backtest, alongside its report. */
export interface BacktestRunMeta {
  readonly instanceId: string;
  readonly strategyId: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly speed: number;
  readonly bars: number;
  readonly ticks: number;
}

/** A completed variant backtest: what ran, and the report it produced. */
export interface BacktestRunResult {
  readonly meta: BacktestRunMeta;
  /** The variant's parameter overrides (for persistence / display). */
  readonly variantParams: Record<string, unknown>;
  readonly report: BacktestReport;
}

/** Everything a single variant backtest needs to run and be reduced. */
export interface VariantBacktestDeps {
  readonly variant: StrategyVariantSpec;
  readonly request: ReplayRequest;
  readonly clock: SettableClock;
  readonly feed: ReplayFeed;
  readonly source: ReplayBarSource;
  readonly pipeline: OutcomeTallyingPipeline;
  readonly analyst: StubbingCountingAnalyst;
  /** The run's isolated virtual portfolio — drained for closed trades. */
  readonly sim: Simulator;
  /** Defaults to {@link NoopPacer} (full speed). */
  readonly pacer?: ReplayPacer;
}

/**
 * Run one variant's backtest and reduce it to a {@link BacktestRunResult}.
 * Full speed by default (no pacer sleeps). The variant's trades are drained
 * per-strategy so a shared simulator (unusual here) wouldn't cross-contaminate.
 */
export async function runVariantBacktest(
  deps: VariantBacktestDeps,
): Promise<BacktestRunResult> {
  const engine = new ReplayEngine(
    deps.clock,
    deps.feed,
    deps.pipeline,
    deps.source,
    deps.pacer ?? new NoopPacer(),
  );
  const result = await engine.run(deps.request);

  const simTrades = deps.sim.drainClosedTrades(deps.request.strategyId);
  const report = buildBacktestReport({
    trades: simTradesToClosedTrades(simTrades),
    outcomes: deps.pipeline.outcomes,
    analyses: deps.analyst.analyses,
    stubbed: deps.analyst.stubbed,
  });

  return {
    meta: {
      instanceId: deps.variant.instanceId,
      strategyId: deps.variant.strategyId,
      label: deps.variant.label,
      from: deps.request.from.toISOString(),
      to: deps.request.to.toISOString(),
      speed: deps.request.speed,
      bars: result.barsProcessed,
      ticks: result.ticks,
    },
    variantParams: { ...deps.variant.params },
    report,
  };
}
