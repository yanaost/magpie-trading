/**
 * T3.5 acceptance — variant backtest reports (AC).
 *
 * Runs the *real* Snapback strategy with two wait-time variants (30 vs 60 min)
 * over a 3-month window of synthetic sessions, each driven through the *real*
 * {@link ReplayEngine} + *real* {@link PipelineService} + *real* {@link Simulator}
 * and the {@link ReplayLlmAnalyst} on an empty cache (so every analysis is
 * replay-stubbed). Asserts the AC:
 *
 *  - both variants produce a comparable {@link BacktestReport} (same shape, real
 *    performance + per-rule veto stats);
 *  - the reports *differ* — the 30-min wait admits an earlier setup the 60-min
 *    wait filters out, so it trades strictly more (proves the param matters);
 *  - both reports carry the visible `REPLAY_STUBBED` caveat (`replayStubbed`
 *    true, stubbed fraction 1) because no cached analyses existed.
 *
 * Only persistence/notification ports are faked; the whole money path (scan →
 * LLM gate → risk sizing → bracket fill → target/stop exit) is real.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RISK_PARAMS,
  RiskManager,
  Simulator,
  type Candle,
  type ExecutionTarget,
  type MarketContext,
  type Position,
  type Quote,
  type Ticker,
} from "@magpie/core";
import {
  StaticPremarketScreener,
  buildVariantStrategy,
  snapbackWaitVariants,
  type PremarketGapper,
  type StrategyVariantSpec,
} from "@magpie/strategies";
import { InMemoryBracketIndex } from "../pipeline/bracket-index.js";
import { PipelineService } from "../pipeline/pipeline.service.js";
import type {
  JournalEntry,
  PipelineAuditEntry,
  PipelineAuditSink,
  ProposalNotifier,
  StrategyRegistry,
  StrategyRuntime,
} from "../pipeline/pipeline.types.js";
import {
  NullAnalysisCache,
  ReplayLlmAnalyst,
} from "../replay/replay-analyst.js";
import { ReplayClock } from "../replay/replay-clock.js";
import type {
  ReplayBarSource,
  ReplayFeed,
  ReplayRequest,
} from "../replay/replay-engine.js";
import {
  OutcomeTallyingPipeline,
  StubbingCountingAnalyst,
  runVariantBacktest,
} from "./backtest-runner.js";

const TICK: Ticker = "SNAP";
const TF = "5m";
const MIN = 60_000;
const DAY = 86_400_000;

/** The small-cap gapper the screener surfaces every session (−12.7%, in band). */
const GAPPER: PremarketGapper = {
  ticker: TICK,
  prevClose: 110,
  premarketPrice: 96,
  marketCap: 1_000_000_000,
};

/**
 * One synthetic session (14 × 5-min bars from 13:30 UTC) engineered so the
 * snapback reclaim first prints at +45 min (bar 9) and re-prints at +60 min
 * (bar 12), both resolving to the take-profit by +65 min:
 *
 *   - opening range (bars 0-2) low = 100;
 *   - day low 90 at bar 3, then a rising higher-low base held above it;
 *   - bar 9 closes 101 (> ORL) on 3× volume → the 30-min wait fires here;
 *   - bars 10-11 dip back below the ORL (no signal) — the 60-min wait is blind
 *     to the earlier setup and only fires at bar 12 (close 102, 3× volume);
 *   - bar 13 spikes to 107 → every open bracket hits its target (all wins).
 *
 * The 30-min variant therefore takes *two* entries per session (bars 9 and 12),
 * the 60-min variant *one* (bar 12) — a clean, deterministic divergence.
 */
function buildSession(dayMs: number): Candle[] {
  const open = dayMs + 13 * 60 * MIN + 30 * MIN; // 13:30:00Z
  const bar = (
    i: number,
    low: number,
    close: number,
    high: number,
    volume: number,
  ): Candle => ({
    ticker: TICK,
    timeframe: TF,
    ts: new Date(open + i * 5 * MIN),
    open: close,
    high,
    low,
    close,
    volume,
  });
  return [
    bar(0, 100, 100, 100, 1_000),
    bar(1, 100, 100, 100, 1_000),
    bar(2, 100, 100, 100, 1_000),
    bar(3, 90, 91, 100, 1_000), // day low 90
    bar(4, 91, 93, 94, 1_000),
    bar(5, 91.5, 94, 95, 1_000),
    bar(6, 92, 95, 96, 1_000),
    bar(7, 92.5, 96, 97, 1_000),
    bar(8, 93, 97, 98, 1_000),
    bar(9, 95, 101, 102, 3_000), // reclaim #1 → 30-min fires
    bar(10, 96, 99, 99, 1_000), // dip < ORL: no signal
    bar(11, 96, 99, 99, 1_000),
    bar(12, 97, 102, 103, 3_000), // reclaim #2 → 60-min (and 30-min) fire
    bar(13, 104, 106, 107, 500), // spike → targets hit; low vol → no new signal
  ];
}

/** Twelve weekly sessions ≈ a 3-month replay window. */
const BASE_MONDAY = Date.UTC(2026, 0, 5); // 2026-01-05
const SESSIONS = Array.from({ length: 12 }, (_, w) =>
  buildSession(BASE_MONDAY + w * 7 * DAY),
);
const ALL_BARS: Candle[] = SESSIONS.flat();

/** Point-in-time market view: the *current* session's bars up to `now`. */
class FixtureMarketContext implements MarketContext {
  readonly target: ExecutionTarget = "SIM";
  constructor(
    readonly now: Date,
    private readonly bars: readonly Candle[],
  ) {}
  async candles(ticker: Ticker): Promise<Candle[]> {
    const dayStart = Date.UTC(
      this.now.getUTCFullYear(),
      this.now.getUTCMonth(),
      this.now.getUTCDate(),
    );
    const dayEnd = dayStart + DAY;
    const nowMs = this.now.getTime();
    return this.bars.filter(
      (c) =>
        c.ticker === ticker &&
        c.ts.getTime() >= dayStart &&
        c.ts.getTime() < dayEnd &&
        c.ts.getTime() <= nowMs,
    );
  }
  async latestQuote(): Promise<Quote | null> {
    return null;
  }
  async accountEquity(): Promise<number> {
    return 100_000;
  }
  async openPositions(): Promise<Position[]> {
    return [];
  }
}

/** Minimal persistence/notify fakes (UUIDs so the sim's zod schemas pass). */
class FakeSignalStore {
  seq = 0;
  async persist(): Promise<{ id: string }> {
    this.seq += 1;
    return {
      id: `00000000-0000-0000-0000-00000000${String(this.seq).padStart(4, "0")}`,
    };
  }
}
class FakeProposalStore {
  seq = 0;
  async persist(): Promise<{ id: string }> {
    this.seq += 1;
    return {
      id: `00000000-0000-4000-8000-00000000${String(this.seq).padStart(4, "0")}`,
    };
  }
  async markExecuted(): Promise<void> {}
  async reject(): Promise<void> {}
  async get(): Promise<null> {
    return null;
  }
  async listPendingDetailed(): Promise<[]> {
    return [];
  }
  async listPending(): Promise<[]> {
    return [];
  }
  async expire(): Promise<void> {}
}
class FakeJournal {
  readonly entries: JournalEntry[] = [];
  async append(entry: JournalEntry): Promise<void> {
    this.entries.push(entry);
  }
}
class FakeAudit implements PipelineAuditSink {
  readonly entries: PipelineAuditEntry[] = [];
  async append(entry: PipelineAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}
class FakeNotifier implements ProposalNotifier {
  async proposalPending(): Promise<void> {}
}

/** Assemble a real pipeline + engine wiring for one variant, sharing one sim. */
function buildHarness(variant: StrategyVariantSpec) {
  const sim = new Simulator();
  const clock = new ReplayClock(new Date(ALL_BARS[0]!.ts));
  const screener = new StaticPremarketScreener([GAPPER]);
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
  // Empty cache → every analysis is replay-stubbed; pass-rate 1 → always proceed.
  const analyst = new StubbingCountingAnalyst(
    new ReplayLlmAnalyst(new NullAnalysisCache(), { stubPassRate: 1 }),
  );

  const service = new PipelineService(
    registry,
    analyst,
    new FakeSignalStore() as never,
    new FakeProposalStore() as never,
    { async persist() {} } as never,
    new FakeJournal() as never,
    new FakeAudit(),
    new FakeNotifier(),
    {
      async check() {
        return { crowded: false };
      },
    },
    {
      async contextFor(_target: ExecutionTarget, now: Date) {
        return new FixtureMarketContext(now, ALL_BARS);
      },
    },
    { portFor: () => sim },
    {
      async isActive() {
        return false;
      },
    },
    new InMemoryBracketIndex(),
    clock,
    // No governor: AUTO runs unbraked and closed trades stay buffered for the
    // final drain (the governor would otherwise consume them mid-run).
  );

  const pipeline = new OutcomeTallyingPipeline(service);
  const feed: ReplayFeed = { onBar: (b) => sim.onBar(b) };
  const source: ReplayBarSource = { bars: async () => ALL_BARS };
  const request: ReplayRequest = {
    strategyId: strategy.id,
    from: new Date(ALL_BARS[0]!.ts),
    to: new Date(ALL_BARS[ALL_BARS.length - 1]!.ts.getTime() + MIN),
    speed: 1,
  };

  return { variant, request, clock, feed, source, pipeline, analyst, sim };
}

describe("T3.5 AC — snapback 30 vs 60-min wait backtest reports", () => {
  it("produces two comparable reports that differ and carry the REPLAY_STUBBED caveat", async () => {
    const [v30, v60] = snapbackWaitVariants([30, 60]);

    const r30 = await runVariantBacktest(buildHarness(v30!));
    const r60 = await runVariantBacktest(buildHarness(v60!));

    // Both ran the full window and produced a shaped report.
    for (const r of [r30, r60]) {
      expect(r.meta.strategyId).toBe("snapback");
      expect(r.meta.bars).toBe(ALL_BARS.length);
      expect(r.report.performance).toBeDefined();
      expect(r.report.vetoStats).toBeDefined();
    }
    expect(r30.meta.label).toBe("30-min wait");
    expect(r60.meta.label).toBe("60-min wait");

    // The 30-min wait catches the earlier reclaim the 60-min wait misses, so it
    // executes and closes strictly more trades — the reports are comparable but
    // genuinely different (the whole point of the variant tab).
    expect(r30.report.vetoStats.executed).toBeGreaterThan(
      r60.report.vetoStats.executed,
    );
    expect(r30.report.performance.trades).toBeGreaterThan(
      r60.report.performance.trades,
    );
    expect(r60.report.performance.trades).toBeGreaterThan(0);
    expect(r30.report.performance.totalPnl).not.toBe(
      r60.report.performance.totalPnl,
    );

    // Both reports visibly carry the replay-stub caveat (no cached analyses).
    for (const r of [r30, r60]) {
      expect(r.report.replayStubbed).toBe(true);
      expect(r.report.stubbing.analyses).toBeGreaterThan(0);
      expect(r.report.stubbing.stubbedFraction).toBe(1);
    }
  });
});
