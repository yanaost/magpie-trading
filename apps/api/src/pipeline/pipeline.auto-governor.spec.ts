/**
 * T3.4 AUTO-mode hardening — the chaos test (AC).
 *
 * Feeds a pathological whipsaw day (every entry immediately stopped out) into a
 * strategy running AUTO+SIM through the *real* {@link Simulator} and the *real*
 * {@link AutoGovernor}, and asserts the two circuit breakers fire instead of the
 * strategy bleeding:
 *
 *  - the consecutive-loss cooldown demotes AUTO→APPROVE (persisted + notified),
 *    and once demoted the strategy's signals route through approval, not
 *    execution — no more unattended entries;
 *  - the daily trade cap independently blocks auto entries past the limit.
 *
 * Only the persistence/notification ports are faked; the money path (risk
 * sizing, bracket placement, fill model, exit reconciliation) is real.
 */
import { describe, expect, it } from "vitest";
import {
  AutoGovernor,
  DEFAULT_RISK_PARAMS,
  RiskManager,
  Simulator,
  type AnalysisRequest,
  type Candle,
  type ExecutionTarget,
  type ExitAction,
  type LLMAnalysis,
  type MarketContext,
  type Mode,
  type Position,
  type ProposalDraft,
  type QuantSignal,
  type Quote,
  type Strategy,
  type Ticker,
} from "@magpie/core";
import { InMemoryBracketIndex } from "./bracket-index.js";
import { PipelineService } from "./pipeline.service.js";
import type {
  AutoDemotionEvent,
  AutoEntryEvent,
  AutoExitEvent,
  AutoModeController,
  AutoTradeNotifier,
  JournalEntry,
  LlmAnalyst,
  PipelineAuditEntry,
  PipelineAuditSink,
  ProposalNotifier,
  StrategyRegistry,
  StrategyRuntime,
} from "./pipeline.types.js";

const SID = "squeeze-scalp";
const TICK: Ticker = "SQZ";
const NOW = new Date("2026-07-06T14:30:00.000Z");
const ENTRY = 100;
const STOP = 95;
const TARGET = 110;

const PROCEED: LLMAnalysis = {
  verdict: "proceed",
  confidence: 0.8,
  reasoning: "clear",
  flaggedRisks: [],
};

/** Always fires one fresh long signal; never manages (the sim's stop closes). */
class WhipsawStrategy implements Strategy {
  readonly id = SID;
  readonly name = "Squeeze Scalp";
  readonly timeframe = "intraday" as Strategy["timeframe"];
  readonly defaultMode: Mode = "AUTO";
  readonly riskParams = DEFAULT_RISK_PARAMS;
  readonly meta = {
    summary: "test",
    mechanic: {
      trigger: ["t"],
      exitPlan: ["e"],
      llmRole: "l",
      dataNeeds: "d",
    },
    dataReady: true,
  };
  async universe(): Promise<Ticker[]> {
    return [TICK];
  }
  async scan(): Promise<QuantSignal[]> {
    return [
      {
        strategyId: SID,
        ticker: TICK,
        trigger: { fired: true },
        quantMetrics: {},
      },
    ];
  }
  llmPrompt(signal: QuantSignal): AnalysisRequest {
    return {
      strategyId: SID,
      ticker: signal.ticker,
      prompt: "verify",
      context: {},
      requiredChecks: [],
      webSearch: false,
    };
  }
  buildProposal(signal: QuantSignal): ProposalDraft {
    return {
      strategyId: SID,
      ticker: signal.ticker,
      side: "long",
      requestedQty: 100,
      entry: ENTRY,
      stop: STOP,
      target: TARGET,
      exitPlan: { stopLoss: STOP, rules: [] },
    };
  }
  manage(): ExitAction | null {
    return null;
  }
}

class FakeAnalyst implements LlmAnalyst {
  async analyze(_req: AnalysisRequest): Promise<LLMAnalysis> {
    return PROCEED;
  }
}

/** Records demotions and flips the shared runtime's mode, like the DB writer. */
class FakeAutoModeController implements AutoModeController {
  readonly demotions: string[] = [];
  constructor(private readonly runtime: { mode: Mode }) {}
  async demote(strategyId: string): Promise<void> {
    this.demotions.push(strategyId);
    this.runtime.mode = "APPROVE";
  }
}

class FakeAutoNotifier implements AutoTradeNotifier {
  readonly entries: AutoEntryEvent[] = [];
  readonly exits: AutoExitEvent[] = [];
  readonly demoted_: AutoDemotionEvent[] = [];
  async autoEntry(e: AutoEntryEvent): Promise<void> {
    this.entries.push(e);
  }
  async autoExit(e: AutoExitEvent): Promise<void> {
    this.exits.push(e);
  }
  async demoted(e: AutoDemotionEvent): Promise<void> {
    this.demoted_.push(e);
  }
}

/** Minimal fakes for the persistence/notify ports the money path doesn't test. */
class FakeSignalStore {
  seq = 0;
  async persist(): Promise<{ id: string }> {
    this.seq += 1;
    return { id: `00000000-0000-0000-0000-00000000000${this.seq % 10}` };
  }
}
class FakeProposalStore {
  seq = 0;
  readonly persisted = new Map<string, unknown>();
  async persist(): Promise<{ id: string }> {
    this.seq += 1;
    return {
      id: `00000000-0000-4000-8000-0000000000${String(this.seq).padStart(2, "0")}`,
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
  readonly notified: unknown[] = [];
  async proposalPending(p: unknown): Promise<void> {
    this.notified.push(p);
  }
}

class SimMarketContext implements MarketContext {
  readonly now = NOW;
  readonly target: ExecutionTarget = "SIM";
  async candles(): Promise<Candle[]> {
    return [];
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

function bar(
  fields: Partial<Candle> & { close: number },
  atMinute: number,
): Candle {
  const c = fields.close;
  return {
    ticker: TICK,
    timeframe: "5m",
    ts: new Date(NOW.getTime() + atMinute * 60_000),
    open: fields.open ?? c,
    high: fields.high ?? Math.max(fields.open ?? c, c),
    low: fields.low ?? Math.min(fields.open ?? c, c),
    close: c,
    volume: 1_000,
  };
}

function build(params: {
  maxTradesPerDay?: number;
  maxConsecutiveLosses?: number;
}) {
  const sim = new Simulator();
  const runtime: StrategyRuntime = {
    strategy: new WhipsawStrategy(),
    mode: "AUTO",
    executionTarget: "SIM",
    riskManager: new RiskManager(DEFAULT_RISK_PARAMS),
  };
  const registry: StrategyRegistry = {
    async getRuntime(id) {
      return id === SID ? runtime : undefined;
    },
    async all() {
      return [runtime];
    },
  };
  const governor = new AutoGovernor({
    maxTradesPerDay: params.maxTradesPerDay ?? 99,
    maxConsecutiveLosses: params.maxConsecutiveLosses ?? 99,
  });
  const autoMode = new FakeAutoModeController(runtime as { mode: Mode });
  const autoNotifier = new FakeAutoNotifier();
  const journal = new FakeJournal();
  const audit = new FakeAudit();

  const service = new PipelineService(
    registry,
    new FakeAnalyst(),
    new FakeSignalStore() as never,
    new FakeProposalStore() as never,
    { async persist() {} } as never,
    journal as never,
    audit,
    new FakeNotifier(),
    {
      async check() {
        return { crowded: false };
      },
    },
    {
      async contextFor() {
        return new SimMarketContext();
      },
    },
    {
      portFor() {
        return sim;
      },
    },
    {
      async isActive() {
        return false;
      },
    },
    new InMemoryBracketIndex(),
    { now: () => NOW },
    governor,
    autoMode,
    autoNotifier,
  );
  return {
    service,
    sim,
    runtime,
    governor,
    autoMode,
    autoNotifier,
    journal,
    audit,
  };
}

/**
 * One whipsaw cycle: quote the open (fills the market entry), scan (auto entry),
 * then slam price through the stop and run the monitor (books the loss).
 */
async function whipsawCycle(
  h: ReturnType<typeof build>,
  minute: number,
): Promise<string> {
  h.sim.onBar(bar({ close: ENTRY }, minute));
  const [outcome] = await h.service.runScan(SID);
  h.sim.onBar(
    bar(
      { open: ENTRY, high: ENTRY + 1, low: STOP - 5, close: STOP - 3 },
      minute + 1,
    ),
  );
  await h.service.monitorPositions(SID);
  return outcome?.kind ?? "none";
}

describe("T3.4 chaos — consecutive-loss cooldown demotes AUTO→APPROVE", () => {
  it("stops bleeding after N losses instead of trading every signal", async () => {
    const h = build({ maxConsecutiveLosses: 3 });

    const kinds: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      kinds.push(await whipsawCycle(h, i * 10));
    }

    // Exactly the first 3 signals executed; the 3rd loss tripped the cooldown.
    const executed = kinds.filter((k) => k === "executed").length;
    expect(executed).toBe(3);

    // Demotion happened exactly once, was persisted, and flipped the mode.
    expect(h.autoMode.demotions).toEqual([SID]);
    expect(h.runtime.mode).toBe("APPROVE");
    expect(h.autoNotifier.demoted_).toHaveLength(1);
    expect(h.autoNotifier.demoted_[0]!.consecutiveLosses).toBe(3);

    // Every auto entry and exit was notified.
    expect(h.autoNotifier.entries).toHaveLength(3);
    expect(h.autoNotifier.exits).toHaveLength(3);
    expect(h.autoNotifier.exits.every((e) => e.realizedPnl < 0)).toBe(true);

    // Post-demotion the signals route through approval, not execution.
    expect(kinds.slice(3).every((k) => k === "proposed")).toBe(true);

    // The demotion is audited as an AUTO→APPROVE strategy change.
    const demoteAudit = h.audit.entries.find((e) => e.action === "auto_demote");
    expect(demoteAudit?.after).toMatchObject({ mode: "APPROVE" });
  });
});

describe("T3.4 chaos — daily trade cap blocks further auto entries", () => {
  it("caps auto entries at the limit even without a demotion", async () => {
    // Cooldown effectively disabled; only the daily cap should bite.
    const h = build({ maxTradesPerDay: 4, maxConsecutiveLosses: 99 });

    const kinds: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      kinds.push(await whipsawCycle(h, i * 10));
    }

    expect(kinds.filter((k) => k === "executed").length).toBe(4);
    // Past the cap, entries are blocked (not demoted → still AUTO).
    expect(kinds.filter((k) => k === "auto-capped").length).toBe(5);
    expect(h.runtime.mode).toBe("AUTO");
    expect(h.autoMode.demotions).toHaveLength(0);
    // No bracket was placed for a capped signal.
    expect(h.autoNotifier.entries).toHaveLength(4);
  });
});
