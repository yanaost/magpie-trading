/**
 * The signal pipeline orchestrator (spec §4.2, T1.6).
 *
 * One method per stage of the flow, wired only through the ports in
 * `pipeline.types.ts` so the whole thing is integration-testable with in-memory
 * fakes:
 *
 *   scheduler tick → scan → LLM analyst → crowding filter → RiskManager →
 *   mode gate (AUTO executes · APPROVE proposes+notifies · WATCH logs) →
 *   position monitor (Strategy.manage → bracket modify/cancel)
 *
 * The money-path invariants live in the collaborators (`RiskManager` sizes and
 * gates; the LLM analyst fails safe to veto; the execution port brackets every
 * entry). This service only sequences them and records the audit/journal trail.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  BracketOrderRequest,
  DecidedBy,
  ExecutionTarget,
  ExitAction,
  MarketContext,
  Position,
  ProposalStatus,
  QuantSignal,
  Side,
  Ticker,
  TradeProposal,
} from "@magpie/core";
import {
  BRACKET_INDEX,
  CROWDING_FILTER,
  EXECUTION_PORT_PROVIDER,
  JOURNAL_SINK,
  KILL_SWITCH_GATE,
  LLM_ANALYST,
  MARKET_CONTEXT_PROVIDER,
  PIPELINE_AUDIT_SINK,
  PIPELINE_CLOCK,
  PROPOSAL_NOTIFIER,
  PROPOSAL_STORE,
  RISK_EVENT_STORE,
  SIGNAL_STORE,
  STRATEGY_REGISTRY,
  type BracketIndex,
  type Clock,
  type CrowdingFilter,
  type ExecutionPortProvider,
  type JournalSink,
  type KillSwitchGate,
  type LlmAnalyst,
  type MarketContextProvider,
  type PipelineAuditSink,
  type ProposalNotifier,
  type ProposalStore,
  type RiskEventStore,
  type SignalStore,
  type StrategyRegistry,
  type StrategyRuntime,
} from "./pipeline.types.js";

/** The outcome of processing one signal — surfaced for tests/observability. */
export type SignalOutcome =
  | { kind: "vetoed"; ticker: string; reason: string }
  | { kind: "crowded"; ticker: string }
  | { kind: "risk-rejected"; ticker: string; rule: string }
  | { kind: "executed"; ticker: string; proposalId: string; bracketId: string }
  | { kind: "proposed"; ticker: string; proposalId: string }
  | { kind: "watched"; ticker: string };

/** The outcome of a human approve/reject decision on a pending proposal (T1.8). */
export type ProposalDecisionOutcome =
  | {
      kind: "executed";
      id: string;
      ticker: string;
      qty: number;
      bracketId: string;
    }
  | { kind: "rejected"; id: string; ticker: string }
  | { kind: "not-found"; id: string }
  | { kind: "not-pending"; id: string; status: ProposalStatus };

/** Thrown on an invalid approval (e.g. an upward size change). Maps to HTTP 400. */
export class ProposalDecisionError extends Error {}

/** The minimum a persisted proposal must expose to place its bracket. */
interface BracketableProposal {
  id: string;
  strategyId: string;
  ticker: Ticker;
  side: Side;
  qty: number;
  stop: number;
  target?: number;
  executionTarget: ExecutionTarget;
  riskUsd: number;
}

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    @Inject(STRATEGY_REGISTRY) private readonly registry: StrategyRegistry,
    @Inject(LLM_ANALYST) private readonly analyst: LlmAnalyst,
    @Inject(SIGNAL_STORE) private readonly signals: SignalStore,
    @Inject(PROPOSAL_STORE) private readonly proposals: ProposalStore,
    @Inject(RISK_EVENT_STORE) private readonly riskEvents: RiskEventStore,
    @Inject(JOURNAL_SINK) private readonly journal: JournalSink,
    @Inject(PIPELINE_AUDIT_SINK) private readonly audit: PipelineAuditSink,
    @Inject(PROPOSAL_NOTIFIER) private readonly notifier: ProposalNotifier,
    @Inject(CROWDING_FILTER) private readonly crowding: CrowdingFilter,
    @Inject(MARKET_CONTEXT_PROVIDER)
    private readonly marketCtx: MarketContextProvider,
    @Inject(EXECUTION_PORT_PROVIDER)
    private readonly execPorts: ExecutionPortProvider,
    @Inject(KILL_SWITCH_GATE) private readonly killSwitch: KillSwitchGate,
    @Inject(BRACKET_INDEX) private readonly brackets: BracketIndex,
    @Inject(PIPELINE_CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Run one full scan for a strategy: scan → per-signal analysis/risk/mode-gate.
   * OFF strategies are skipped entirely (no scanning, no orders).
   * @param strategyId - the strategy to run
   */
  async runScan(strategyId: string): Promise<SignalOutcome[]> {
    const runtime = await this.registry.getRuntime(strategyId);
    if (!runtime) {
      this.logger.warn(`runScan: unknown strategy ${strategyId}`);
      return [];
    }
    if (runtime.mode === "OFF") {
      this.logger.debug(`${strategyId} is OFF — skipping scan`);
      return [];
    }

    const now = this.clock.now();
    const ctx = await this.marketCtx.contextFor(runtime.executionTarget, now);
    const signals = await runtime.strategy.scan(ctx);

    const outcomes: SignalOutcome[] = [];
    for (const signal of signals) {
      outcomes.push(await this.processSignal(runtime, signal, ctx, now));
    }
    return outcomes;
  }

  /** Process one quant signal through analysis, risk, and the mode gate. */
  private async processSignal(
    runtime: StrategyRuntime,
    signal: QuantSignal,
    ctx: MarketContext,
    now: Date,
  ): Promise<SignalOutcome> {
    const { strategy } = runtime;
    const { id: signalId } = await this.signals.persist(signal);

    // LLM analyst — fail-safe veto lives inside the service.
    const request = { ...strategy.llmPrompt(signal), signalId };
    const analysis = await this.analyst.analyze(request);
    await this.journal.append({
      strategyId: strategy.id,
      entryType: "decision",
      refType: "signal",
      refId: signalId,
      title: `LLM ${analysis.verdict} on ${signal.ticker}`,
      body: analysis.reasoning,
      meta: {
        confidence: analysis.confidence,
        flaggedRisks: analysis.flaggedRisks,
      },
    });
    if (analysis.verdict === "veto") {
      return {
        kind: "vetoed",
        ticker: signal.ticker,
        reason: analysis.reasoning,
      };
    }

    // Crowding filter hook (no-op in T1.6; strategy #6 backs it later).
    if (await this.crowding.isCrowded(signal.ticker)) {
      await this.journal.append({
        strategyId: strategy.id,
        entryType: "decision",
        refType: "signal",
        refId: signalId,
        title: `Crowding veto on ${signal.ticker}`,
      });
      return { kind: "crowded", ticker: signal.ticker };
    }

    // Risk manager — sizes and gates; the LLM never touches these numbers.
    const draft = strategy.buildProposal(signal, analysis);
    const decision = runtime.riskManager.evaluate(draft, {
      now,
      equity: await ctx.accountEquity(),
      executionTarget: runtime.executionTarget,
      openPositions: await ctx.openPositions(),
      killSwitchActive: await this.killSwitch.isActive(),
    });
    if (!decision.approved) {
      await this.riskEvents.persist(decision.event);
      await this.journal.append({
        strategyId: strategy.id,
        entryType: "decision",
        refType: "signal",
        refId: signalId,
        title: `Risk rejected ${signal.ticker}: ${decision.event.rule}`,
        body: decision.event.reason,
        meta: decision.event.context,
      });
      return {
        kind: "risk-rejected",
        ticker: signal.ticker,
        rule: decision.event.rule,
      };
    }

    const proposal: TradeProposal = { ...decision.proposal, signalId };
    return this.gateByMode(runtime, proposal, now);
  }

  /** Route an approved proposal by the strategy's operating mode (spec §3.2). */
  private async gateByMode(
    runtime: StrategyRuntime,
    proposal: TradeProposal,
    now: Date,
  ): Promise<SignalOutcome> {
    switch (runtime.mode) {
      case "AUTO":
        return this.executeAuto(runtime, proposal, now);
      case "APPROVE": {
        const { id } = await this.proposals.persist(proposal);
        await this.notifier.proposalPending({ ...proposal, id });
        await this.journal.append({
          strategyId: runtime.strategy.id,
          entryType: "decision",
          refType: "proposal",
          refId: id,
          title: `Proposal awaiting approval: ${proposal.side} ${proposal.qty} ${proposal.ticker}`,
          meta: { riskUsd: proposal.riskUsd, riskPct: proposal.riskPct },
        });
        return { kind: "proposed", ticker: proposal.ticker, proposalId: id };
      }
      case "WATCH":
      default:
        await this.journal.append({
          strategyId: runtime.strategy.id,
          entryType: "decision",
          refType: "signal",
          refId: proposal.signalId,
          title: `WATCH: would ${proposal.side} ${proposal.qty} ${proposal.ticker}`,
          meta: { riskUsd: proposal.riskUsd, riskPct: proposal.riskPct },
        });
        return { kind: "watched", ticker: proposal.ticker };
    }
  }

  /** AUTO mode: persist, place the bracket, mark executed, audit. */
  private async executeAuto(
    runtime: StrategyRuntime,
    proposal: TradeProposal,
    now: Date,
  ): Promise<SignalOutcome> {
    const { id } = await this.proposals.persist(proposal);
    const { bracketId } = await this.placeBracketAndRecord(
      {
        id,
        strategyId: proposal.strategyId,
        ticker: proposal.ticker,
        side: proposal.side,
        qty: proposal.qty,
        stop: proposal.stop,
        target: proposal.target,
        executionTarget: runtime.executionTarget,
        riskUsd: proposal.riskUsd,
      },
      now,
      "auto",
      "auto_execute",
      "AUTO",
    );
    return {
      kind: "executed",
      ticker: proposal.ticker,
      proposalId: id,
      bracketId,
    };
  }

  /**
   * Approve or reject a pending proposal (T1.8). Shared by the REST controller,
   * the Telegram inline buttons, and any future surface. Approving places the
   * SIM/paper bracket exactly like AUTO mode but attributed to `user`; an
   * optional `qty` may only *reduce* the proposed size (downward-only). The
   * whole decision is idempotent-safe: the underlying status transitions are
   * guarded on `pending`, so a double-tap can't double-execute.
   *
   * @param id - the proposal id
   * @param decision - approve (execute) or reject
   * @param opts.qty - downward-only size override on approve
   */
  async decideProposal(
    id: string,
    decision: "approve" | "reject",
    opts: { qty?: number } = {},
  ): Promise<ProposalDecisionOutcome> {
    const now = this.clock.now();
    const proposal = await this.proposals.get(id);
    if (!proposal) return { kind: "not-found", id };
    if (proposal.status !== "pending") {
      return { kind: "not-pending", id, status: proposal.status };
    }

    if (decision === "reject") {
      await this.proposals.reject(id, now);
      await this.audit.append({
        entityType: "proposal",
        entityId: id,
        action: "reject",
        actor: "user",
        before: { status: "pending", qty: proposal.qty },
        after: { status: "rejected" },
      });
      await this.journal.append({
        strategyId: proposal.strategyId,
        entryType: "decision",
        refType: "proposal",
        refId: id,
        title: `Rejected ${proposal.side} ${proposal.qty} ${proposal.ticker}`,
      });
      return { kind: "rejected", id, ticker: proposal.ticker };
    }

    // Approve — validate the (optional) downward-only size change.
    let qty = proposal.qty;
    if (opts.qty !== undefined) {
      if (!(opts.qty > 0)) {
        throw new ProposalDecisionError("approved qty must be positive");
      }
      if (opts.qty > proposal.qty) {
        throw new ProposalDecisionError(
          `approved qty ${opts.qty} exceeds proposed ${proposal.qty}; size can only be reduced`,
        );
      }
      qty = opts.qty;
    }

    const { bracketId } = await this.placeBracketAndRecord(
      {
        id,
        strategyId: proposal.strategyId,
        ticker: proposal.ticker,
        side: proposal.side,
        qty,
        stop: proposal.stop,
        target: proposal.target,
        executionTarget: proposal.executionTarget,
        riskUsd: proposal.riskUsd,
      },
      now,
      "user",
      "approve_execute",
      "APPROVED",
    );
    return { kind: "executed", id, ticker: proposal.ticker, qty, bracketId };
  }

  /** List the pending proposals for the approval surface (REST/Telegram/WS). */
  async listPendingProposals() {
    return this.proposals.listPendingDetailed();
  }

  /**
   * Place a market bracket for an already-persisted proposal, record the
   * bracket for the monitor, mark the proposal executed, and write the audit +
   * journal trail. Shared by AUTO execution and human approval.
   */
  private async placeBracketAndRecord(
    p: BracketableProposal,
    now: Date,
    decidedBy: DecidedBy,
    action: "auto_execute" | "approve_execute",
    label: string,
  ): Promise<{ bracketId: string }> {
    const port = this.execPorts.portFor(p.executionTarget);
    const request: BracketOrderRequest = {
      strategyId: p.strategyId,
      proposalId: p.id,
      target: p.executionTarget,
      ticker: p.ticker,
      side: p.side,
      qty: p.qty,
      entryType: "market",
      stopPrice: p.stop,
      targetPrice: p.target,
      timeInForce: "DAY",
    };
    const handle = await port.placeBracket(request);
    this.brackets.record(p.strategyId, p.ticker, handle.bracketId);
    await this.proposals.markExecuted(p.id, now, decidedBy, p.qty);
    await this.audit.append({
      entityType: "proposal",
      entityId: p.id,
      action,
      actor: decidedBy === "user" ? "user" : p.strategyId,
      after: {
        bracketId: handle.bracketId,
        qty: p.qty,
        stop: p.stop,
        target: p.target ?? null,
      },
    });
    await this.journal.append({
      strategyId: p.strategyId,
      entryType: "decision",
      refType: "proposal",
      refId: p.id,
      title: `${label} executed ${p.side} ${p.qty} ${p.ticker}`,
      meta: { bracketId: handle.bracketId, decidedBy, riskUsd: p.riskUsd },
    });
    return { bracketId: handle.bracketId };
  }

  /**
   * Position monitor loop (spec §4.3): call `Strategy.manage` on every open
   * position and apply the returned {@link ExitAction} to its working bracket.
   * Runs regardless of mode so exits always protect open positions.
   * @param strategyId - the strategy whose positions to manage
   */
  async monitorPositions(strategyId: string): Promise<number> {
    const runtime = await this.registry.getRuntime(strategyId);
    if (!runtime) return 0;
    const now = this.clock.now();
    const ctx = await this.marketCtx.contextFor(runtime.executionTarget, now);
    const port = this.execPorts.portFor(runtime.executionTarget);
    const positions = await port.getPositions(strategyId);

    let applied = 0;
    for (const position of positions) {
      const action = runtime.strategy.manage(position, ctx);
      if (!action) continue;
      const bracketId = this.brackets.resolve(strategyId, position.ticker);
      if (!bracketId) {
        this.logger.warn(
          `no bracket for ${strategyId}:${position.ticker}; cannot apply ${action.kind}`,
        );
        continue;
      }
      await this.applyExit(port.target, port, bracketId, position, action);
      applied += 1;
    }
    return applied;
  }

  /** Translate an {@link ExitAction} into a bracket modify/cancel. */
  private async applyExit(
    _target: string,
    port: ReturnType<ExecutionPortProvider["portFor"]>,
    bracketId: string,
    position: Position,
    action: ExitAction,
  ): Promise<void> {
    switch (action.kind) {
      case "close": {
        const remaining = action.qty ? position.qty - action.qty : 0;
        if (remaining <= 0) {
          await port.cancelBracket(bracketId);
          this.brackets.clear(position.strategyId, position.ticker);
        } else {
          await port.modifyBracket({ bracketId, newQty: remaining });
        }
        break;
      }
      case "scale-out": {
        const remaining = position.qty - action.qty;
        if (remaining <= 0) {
          await port.cancelBracket(bracketId);
          this.brackets.clear(position.strategyId, position.ticker);
        } else {
          await port.modifyBracket({ bracketId, newQty: remaining });
        }
        break;
      }
      case "modify-stop":
        await port.modifyBracket({
          bracketId,
          newStopPrice: action.newStopPrice,
        });
        break;
      case "modify-target":
        await port.modifyBracket({
          bracketId,
          newTargetPrice: action.newTargetPrice,
        });
        break;
    }
    await this.journal.append({
      strategyId: position.strategyId,
      entryType: "decision",
      refType: "position",
      refId: position.id,
      title: `manage: ${action.kind} ${position.ticker}`,
      body: action.reason,
    });
  }

  /**
   * Sweep pending proposals whose TTL has elapsed: mark them `expired` and
   * write an audit record (T1.6 AC).
   * @returns the number of proposals expired
   */
  async sweepExpiredProposals(): Promise<number> {
    const now = this.clock.now();
    const pending = await this.proposals.listPending();
    let expired = 0;
    for (const p of pending) {
      if (p.expiry.getTime() > now.getTime()) continue;
      await this.proposals.expire(p.id, now);
      await this.audit.append({
        entityType: "proposal",
        entityId: p.id,
        action: "expire",
        actor: "system",
        before: p.snapshot,
        after: { status: "expired", expiredAt: now.toISOString() },
      });
      await this.journal.append({
        strategyId: p.strategyId,
        entryType: "decision",
        refType: "proposal",
        refId: p.id,
        title: `Proposal expired (TTL elapsed)`,
      });
      expired += 1;
    }
    return expired;
  }
}
