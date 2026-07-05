/**
 * Integration test for the signal pipeline (T1.6 AC): drive one signal through
 * every mode branch (AUTO / APPROVE / WATCH / OFF), plus the veto and
 * risk-rejection paths, the position monitor, and the TTL expiry sweep — all
 * with in-memory fakes so it runs in CI without Postgres/Redis/BullMQ.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RISK_PARAMS,
  RiskManager,
  vetoAnalysis,
  type AnalysisRequest,
  type BracketHandle,
  type BracketOrderRequest,
  type Candle,
  type ExecutionPort,
  type ExecutionTarget,
  type ExitAction,
  type LLMAnalysis,
  type MarketContext,
  type Mode,
  type OrderModification,
  type Position,
  type ProposalDraft,
  type QuantSignal,
  type Quote,
  type RiskEvent,
  type Strategy,
  type Ticker,
  type TradeProposal,
} from "@magpie/core";
import { InMemoryBracketIndex } from "./bracket-index.js";
import { PipelineService } from "./pipeline.service.js";
import type {
  JournalEntry,
  LlmAnalyst,
  PendingProposal,
  PipelineAuditEntry,
  PipelineAuditSink,
  ProposalNotifier,
  ProposalStore,
  RiskEventStore,
  SignalStore,
  StrategyRegistry,
  StrategyRuntime,
} from "./pipeline.types.js";

const NOW = new Date("2026-07-05T14:30:00.000Z");

// --- Fakes -----------------------------------------------------------------

class FakeStrategy implements Strategy {
  readonly id = "qual-sphb";
  readonly name = "QUAL/SPHB";
  readonly timeframe = "weekly" as Strategy["timeframe"];
  readonly defaultMode: Mode = "APPROVE";
  readonly riskParams = DEFAULT_RISK_PARAMS;
  manageAction: ExitAction | null = null;

  constructor(private readonly signals: QuantSignal[]) {}

  async universe(): Promise<Ticker[]> {
    return ["QUAL"];
  }
  async scan(): Promise<QuantSignal[]> {
    return this.signals;
  }
  llmPrompt(signal: QuantSignal): AnalysisRequest {
    return {
      strategyId: this.id,
      ticker: signal.ticker,
      prompt: "Verify the rotation thesis.",
      context: {},
      requiredChecks: [],
      webSearch: false,
    };
  }
  buildProposal(signal: QuantSignal): ProposalDraft {
    return {
      strategyId: this.id,
      ticker: signal.ticker,
      side: "long",
      requestedQty: 100,
      entry: 100,
      stop: 95,
      target: 110,
      exitPlan: { stopLoss: 95, rules: [] },
    };
  }
  manage(): ExitAction | null {
    return this.manageAction;
  }
}

class FakeAnalyst implements LlmAnalyst {
  constructor(private readonly result: LLMAnalysis) {}
  async analyze(_req: AnalysisRequest): Promise<LLMAnalysis> {
    return this.result;
  }
}

const PROCEED: LLMAnalysis = {
  verdict: "proceed",
  confidence: 0.8,
  reasoning: "clear",
  flaggedRisks: [],
};

class FakeSignalStore implements SignalStore {
  seq = 0;
  async persist(_signal: QuantSignal): Promise<{ id: string }> {
    this.seq += 1;
    return { id: `00000000-0000-0000-0000-00000000000${this.seq}` };
  }
}

class FakeProposalStore implements ProposalStore {
  seq = 0;
  readonly persisted = new Map<string, TradeProposal>();
  readonly executed: string[] = [];
  readonly expired: string[] = [];
  async persist(proposal: TradeProposal): Promise<{ id: string }> {
    this.seq += 1;
    const id = `prop-${this.seq}`;
    this.persisted.set(id, proposal);
    return { id };
  }
  async markExecuted(id: string): Promise<void> {
    this.executed.push(id);
  }
  async listPending(): Promise<PendingProposal[]> {
    return [...this.persisted.entries()]
      .filter(
        ([id]) => !this.executed.includes(id) && !this.expired.includes(id),
      )
      .map(([id, p]) => ({
        id,
        strategyId: p.strategyId,
        expiry: p.expiry,
        snapshot: { status: "pending" },
      }));
  }
  async expire(id: string): Promise<void> {
    this.expired.push(id);
  }
}

class FakeRiskEventStore implements RiskEventStore {
  readonly events: RiskEvent[] = [];
  async persist(event: RiskEvent): Promise<void> {
    this.events.push(event);
  }
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
  readonly notified: Array<TradeProposal & { id: string }> = [];
  async proposalPending(
    proposal: TradeProposal & { id: string },
  ): Promise<void> {
    this.notified.push(proposal);
  }
}

class FakeExecutionPort implements ExecutionPort {
  readonly target: ExecutionTarget = "SIM";
  readonly placed: BracketOrderRequest[] = [];
  readonly modifications: OrderModification[] = [];
  readonly cancelled: string[] = [];
  private positions: Position[] = [];
  seq = 0;

  setPositions(positions: Position[]): void {
    this.positions = positions;
  }
  async placeBracket(req: BracketOrderRequest): Promise<BracketHandle> {
    this.placed.push(req);
    this.seq += 1;
    const bracketId = `br-${this.seq}`;
    const leg = (role: "parent" | "stop") => ({
      orderId: `${bracketId}-${role}`,
      role,
      status: "working" as const,
      ticker: req.ticker,
      side: req.side,
      qty: req.qty,
    });
    return { bracketId, parent: leg("parent"), stop: leg("stop") };
  }
  async modifyBracket(mod: OrderModification): Promise<void> {
    this.modifications.push(mod);
  }
  async cancelBracket(bracketId: string): Promise<void> {
    this.cancelled.push(bracketId);
  }
  async getPositions(): Promise<Position[]> {
    return this.positions;
  }
  async getFills(): Promise<[]> {
    return [];
  }
}

class FakeMarketContext implements MarketContext {
  readonly now = NOW;
  readonly target: ExecutionTarget = "SIM";
  openPositionsList: Position[] = [];
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
    return this.openPositionsList;
  }
}

/** Assemble a service with a given mode and shared fakes. */
function build(opts: {
  mode: Mode;
  analysis?: LLMAnalysis;
  signals?: QuantSignal[];
  crowded?: boolean;
  killSwitch?: boolean;
}) {
  const signals = opts.signals ?? [
    {
      strategyId: "qual-sphb",
      ticker: "QUAL",
      trigger: { fired: true },
      quantMetrics: {},
    },
  ];
  const strategy = new FakeStrategy(signals);
  const port = new FakeExecutionPort();
  const marketCtx = new FakeMarketContext();
  const runtime: StrategyRuntime = {
    strategy,
    mode: opts.mode,
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
  const proposals = new FakeProposalStore();
  const journal = new FakeJournal();
  const audit = new FakeAudit();
  const notifier = new FakeNotifier();
  const riskEvents = new FakeRiskEventStore();
  const brackets = new InMemoryBracketIndex();

  const service = new PipelineService(
    registry,
    new FakeAnalyst(opts.analysis ?? PROCEED),
    new FakeSignalStore(),
    proposals,
    riskEvents,
    journal,
    audit,
    notifier,
    {
      async isCrowded() {
        return opts.crowded ?? false;
      },
    },
    {
      async contextFor() {
        return marketCtx;
      },
    },
    {
      portFor() {
        return port;
      },
    },
    {
      async isActive() {
        return opts.killSwitch ?? false;
      },
    },
    brackets,
    { now: () => NOW },
  );
  return {
    service,
    strategy,
    port,
    proposals,
    journal,
    audit,
    notifier,
    riskEvents,
    marketCtx,
    brackets,
  };
}

// --- Tests -----------------------------------------------------------------

describe("PipelineService — mode gate", () => {
  it("AUTO executes a bracket, marks the proposal executed, and audits it", async () => {
    const h = build({ mode: "AUTO" });
    const [outcome] = await h.service.runScan("qual-sphb");
    if (!outcome) throw new Error("expected an outcome");

    expect(outcome.kind).toBe("executed");
    expect(h.port.placed).toHaveLength(1);
    expect(h.port.placed[0]).toMatchObject({
      ticker: "QUAL",
      side: "long",
      entryType: "market",
    });
    expect(h.proposals.executed).toHaveLength(1);
    expect(h.audit.entries.some((e) => e.action === "auto_execute")).toBe(true);
    // The bracket is indexed for later management.
    expect(h.brackets.resolve("qual-sphb", "QUAL")).toBeDefined();
  });

  it("APPROVE persists a pending proposal and notifies, without executing", async () => {
    const h = build({ mode: "APPROVE" });
    const [outcome] = await h.service.runScan("qual-sphb");
    if (!outcome) throw new Error("expected an outcome");

    expect(outcome.kind).toBe("proposed");
    expect(h.notifier.notified).toHaveLength(1);
    expect(h.port.placed).toHaveLength(0);
    expect(h.proposals.persisted.size).toBe(1);
    expect(h.proposals.executed).toHaveLength(0);
  });

  it("WATCH logs only — no proposal, no order, no notification", async () => {
    const h = build({ mode: "WATCH" });
    const [outcome] = await h.service.runScan("qual-sphb");
    if (!outcome) throw new Error("expected an outcome");

    expect(outcome.kind).toBe("watched");
    expect(h.proposals.persisted.size).toBe(0);
    expect(h.port.placed).toHaveLength(0);
    expect(h.notifier.notified).toHaveLength(0);
    expect(h.journal.entries.some((e) => e.title.startsWith("WATCH"))).toBe(
      true,
    );
  });

  it("OFF skips scanning entirely", async () => {
    const h = build({ mode: "OFF" });
    const outcomes = await h.service.runScan("qual-sphb");
    expect(outcomes).toHaveLength(0);
    expect(h.proposals.persisted.size).toBe(0);
  });

  it("veto stops the signal before risk/mode gate", async () => {
    const h = build({
      mode: "AUTO",
      analysis: vetoAnalysis("earnings in 2 days"),
    });
    const [outcome] = await h.service.runScan("qual-sphb");
    if (!outcome) throw new Error("expected an outcome");
    expect(outcome.kind).toBe("vetoed");
    expect(h.port.placed).toHaveLength(0);
    expect(h.proposals.persisted.size).toBe(0);
  });

  it("crowding filter vetoes a proceed signal", async () => {
    const h = build({ mode: "AUTO", crowded: true });
    const [outcome] = await h.service.runScan("qual-sphb");
    if (!outcome) throw new Error("expected an outcome");
    expect(outcome.kind).toBe("crowded");
    expect(h.port.placed).toHaveLength(0);
  });

  it("risk rejection (kill switch) records a risk event and does not execute", async () => {
    const h = build({ mode: "AUTO", killSwitch: true });
    const [outcome] = await h.service.runScan("qual-sphb");
    if (!outcome) throw new Error("expected an outcome");
    expect(outcome.kind).toBe("risk-rejected");
    if (outcome.kind === "risk-rejected")
      expect(outcome.rule).toBe("kill_switch_active");
    expect(h.riskEvents.events).toHaveLength(1);
    expect(h.port.placed).toHaveLength(0);
  });
});

describe("PipelineService — position monitor", () => {
  it("applies a modify-stop from Strategy.manage to the working bracket", async () => {
    const h = build({ mode: "AUTO" });
    await h.service.runScan("qual-sphb"); // opens + indexes the bracket
    const bracketId = h.brackets.resolve("qual-sphb", "QUAL");

    const position: Position = {
      strategyId: "qual-sphb",
      target: "SIM",
      ticker: "QUAL",
      side: "long",
      status: "open",
      qty: 200,
      avgEntryPrice: 100,
      stopPrice: 95,
      realizedPnl: 0,
      unrealizedPnl: 0,
      openedAt: NOW,
    };
    h.port.setPositions([position]);
    h.strategy.manageAction = {
      kind: "modify-stop",
      newStopPrice: 98,
      reason: "trail up",
    };

    const applied = await h.service.monitorPositions("qual-sphb");
    expect(applied).toBe(1);
    expect(h.port.modifications).toEqual([{ bracketId, newStopPrice: 98 }]);
  });

  it("a close action cancels the bracket and clears the index", async () => {
    const h = build({ mode: "AUTO" });
    await h.service.runScan("qual-sphb");
    const bracketId = h.brackets.resolve("qual-sphb", "QUAL");

    h.port.setPositions([
      {
        strategyId: "qual-sphb",
        target: "SIM",
        ticker: "QUAL",
        side: "long",
        status: "open",
        qty: 200,
        avgEntryPrice: 100,
        stopPrice: 95,
        realizedPnl: 0,
        unrealizedPnl: 0,
        openedAt: NOW,
      },
    ]);
    h.strategy.manageAction = { kind: "close", reason: "target reverted" };

    await h.service.monitorPositions("qual-sphb");
    expect(h.port.cancelled).toEqual([bracketId]);
    expect(h.brackets.resolve("qual-sphb", "QUAL")).toBeUndefined();
  });
});

describe("PipelineService — TTL expiry sweep", () => {
  it("expires proposals past their TTL and audits each expiry", async () => {
    const h = build({ mode: "APPROVE" });
    await h.service.runScan("qual-sphb"); // creates a pending proposal (expiry = NOW + 15m)

    // Nothing expired yet: the fresh proposal's expiry is in the future.
    expect(await h.service.sweepExpiredProposals()).toBe(0);

    // Push the proposal's TTL into the past, then sweep: it must expire + audit.
    const proposalId = [...h.proposals.persisted.keys()][0]!;
    h.proposals.persisted.get(proposalId)!.expiry.setTime(NOW.getTime() - 1000);
    const expired = await h.service.sweepExpiredProposals();

    expect(expired).toBe(1);
    expect(h.proposals.expired).toContain(proposalId);
    expect(
      h.audit.entries.some(
        (e) => e.action === "expire" && e.entityId === proposalId,
      ),
    ).toBe(true);
  });
});
