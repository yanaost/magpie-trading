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
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type {
  BracketOrderRequest,
  SimClosedTrade,
  DecidedBy,
  ExecutionTarget,
  ExitAction,
  MarketContext,
  Position,
  ProposalDraft,
  ProposalStatus,
  QuantSignal,
  Side,
  Ticker,
  TradeProposal,
} from "@magpie/core";
import {
  AUTO_GOVERNOR,
  AUTO_MODE_CONTROLLER,
  AUTO_TRADE_NOTIFIER,
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
  type AutoGovernor,
  type AutoModeController,
  type AutoTradeNotifier,
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
  | { kind: "crowded"; ticker: string; reason: "CROWDED_TICKER" }
  | { kind: "risk-rejected"; ticker: string; rule: string }
  | { kind: "executed"; ticker: string; proposalId: string; bracketId: string }
  | { kind: "proposed"; ticker: string; proposalId: string }
  | { kind: "auto-capped"; ticker: string; reason: string }
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
    // AUTO-mode hardening (T3.4). Optional so pre-T3.4 wiring/tests still
    // construct the service; when absent, AUTO execution runs unbraked.
    @Optional() @Inject(AUTO_GOVERNOR) private readonly governor?: AutoGovernor,
    @Optional()
    @Inject(AUTO_MODE_CONTROLLER)
    private readonly autoMode?: AutoModeController,
    @Optional()
    @Inject(AUTO_TRADE_NOTIFIER)
    private readonly autoNotifier?: AutoTradeNotifier,
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

    // Build the trade idea so we know the side before the crowding/risk gates.
    const draft = strategy.buildProposal(signal, analysis);

    // Crowding filter (strategy #6, T2.4): veto NEW-LONG entries on names the
    // nightly research job flagged as over-recommended. Shorts and exits pass.
    if (draft.side === "long") {
      const status = await this.crowding.check(signal.ticker);
      if (status.crowded) {
        await this.journal.append({
          strategyId: strategy.id,
          entryType: "decision",
          refType: "signal",
          refId: signalId,
          title: `Crowding veto on ${signal.ticker} (CROWDED_TICKER)`,
          body: status.evidence,
          meta: { reason: "CROWDED_TICKER" },
        });
        return {
          kind: "crowded",
          ticker: signal.ticker,
          reason: "CROWDED_TICKER",
        };
      }
    }

    // Risk manager — sizes and gates; the LLM never touches these numbers.
    const decision = runtime.riskManager.evaluate(draft, {
      now,
      equity: await ctx.accountEquity(strategy.id),
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

  /** AUTO mode: cap-gate, persist, place the bracket, mark executed, audit. */
  private async executeAuto(
    runtime: StrategyRuntime,
    proposal: TradeProposal,
    now: Date,
  ): Promise<SignalOutcome> {
    // T3.4 safety brake: daily trade cap / cooldown. A blocked entry is
    // journalled and dropped — the signal doesn't execute (no bleeding).
    if (this.governor) {
      const admit = this.governor.admitEntry(proposal.strategyId, now);
      if (!admit.allowed) {
        await this.journal.append({
          strategyId: proposal.strategyId,
          entryType: "decision",
          refType: "signal",
          refId: proposal.signalId,
          title: `AUTO entry blocked on ${proposal.ticker}: ${admit.reason}`,
          meta: { reason: admit.reason, guard: "auto-governor" },
        });
        return {
          kind: "auto-capped",
          ticker: proposal.ticker,
          reason: admit.reason,
        };
      }
    }

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
    this.governor?.recordEntry(proposal.strategyId, now);
    if (this.autoNotifier) {
      await this.safeNotify(() =>
        this.autoNotifier!.autoEntry({
          strategyId: proposal.strategyId,
          ticker: proposal.ticker,
          side: proposal.side,
          qty: proposal.qty,
          bracketId,
        }),
      );
    }
    return {
      kind: "executed",
      ticker: proposal.ticker,
      proposalId: id,
      bracketId,
    };
  }

  /**
   * Reconcile the trades that closed on a strategy's rung since the last tick
   * (T3.4): feed each realized win/loss into the governor, notify the operator
   * of the exit, and — on the loss that trips the cooldown — demote AUTO→APPROVE
   * (persisted, audited, notified). A no-op unless the governor is wired and the
   * execution port can surface closed trades (the SIM {@link Simulator} does).
   * @param strategyId - the strategy to reconcile
   * @returns how many trades were reconciled and whether it demoted
   */
  async reconcileAutoResults(
    strategyId: string,
  ): Promise<{ closed: number; demoted: boolean }> {
    if (!this.governor) return { closed: 0, demoted: false };
    const runtime = await this.registry.getRuntime(strategyId);
    if (!runtime) return { closed: 0, demoted: false };
    const port = this.execPorts.portFor(runtime.executionTarget);
    const drain = (
      port as Partial<{ drainClosedTrades(id?: string): SimClosedTrade[] }>
    ).drainClosedTrades;
    if (typeof drain !== "function") return { closed: 0, demoted: false };

    const trades = drain.call(port, strategyId);
    let demoted = false;
    for (const t of trades) {
      // The bracket is gone; drop its index entry so a re-entry can re-bracket.
      this.brackets.clear(strategyId, t.ticker);
      if (this.autoNotifier) {
        await this.safeNotify(() =>
          this.autoNotifier!.autoExit({
            strategyId,
            ticker: t.ticker,
            side: t.side,
            qty: t.qty,
            realizedPnl: t.realizedPnl,
          }),
        );
      }
      const outcome = this.governor.recordResult(
        strategyId,
        t.realizedPnl,
        t.closedAt,
      );
      if (outcome.demote) {
        demoted = true;
        await this.demoteFromAuto(
          strategyId,
          outcome.consecutiveLosses,
          t.closedAt,
        );
      }
    }
    return { closed: trades.length, demoted };
  }

  /** Persist + audit + journal + notify an AUTO→APPROVE cooldown demotion. */
  private async demoteFromAuto(
    strategyId: string,
    consecutiveLosses: number,
    now: Date,
  ): Promise<void> {
    const reason = `consecutive-loss cooldown (${consecutiveLosses} losses)`;
    if (this.autoMode) await this.autoMode.demote(strategyId, reason, now);
    await this.audit.append({
      entityType: "strategy",
      entityId: strategyId,
      action: "auto_demote",
      actor: "system",
      before: { mode: "AUTO" },
      after: { mode: "APPROVE", consecutiveLosses },
    });
    await this.journal.append({
      strategyId,
      entryType: "decision",
      refType: "strategy",
      refId: strategyId,
      title: `AUTO→APPROVE: ${reason}`,
      meta: { reason: "auto-cooldown", consecutiveLosses },
    });
    if (this.autoNotifier) {
      await this.safeNotify(() =>
        this.autoNotifier!.demoted({ strategyId, reason, consecutiveLosses }),
      );
    }
  }

  /** Run a notifier call, swallowing (logging) any failure so it never blocks. */
  private async safeNotify(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`auto-trade notification failed: ${String(err)}`);
    }
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
   * Inject a deterministic synthetic signal for the T1.9 demo (dev-only; gated
   * by the caller). Bypasses the quant scan and the LLM analyst — it fabricates
   * a long-QUAL draft at the ticker's last quote (or a stable fallback) — but
   * runs the *real* risk manager and mode gate, so the money path (sizing,
   * limits, persistence, notification, and AUTO execution) is exercised exactly
   * as in production. In APPROVE mode this leaves a pending proposal for the
   * dashboard/Telegram to approve.
   *
   * @param strategyId - the strategy to inject for
   * @param opts.ticker - override symbol (defaults to QUAL)
   * @param opts.entry - override entry price (defaults to last quote, else 100)
   */
  async injectSyntheticProposal(
    strategyId: string,
    opts: { ticker?: string; entry?: number } = {},
  ): Promise<SignalOutcome> {
    const runtime = await this.registry.getRuntime(strategyId);
    if (!runtime) throw new Error(`unknown strategy ${strategyId}`);
    if (runtime.mode === "OFF") {
      return { kind: "watched", ticker: opts.ticker ?? "QUAL" };
    }

    const now = this.clock.now();
    const ctx = await this.marketCtx.contextFor(runtime.executionTarget, now);
    const ticker = (opts.ticker ?? "QUAL") as Ticker;
    const quote = await ctx.latestQuote(ticker);
    const entry = opts.entry ?? quote?.last ?? 100;
    const stop = Math.round(entry * 0.92 * 100) / 100;

    const { id: signalId } = await this.signals.persist({
      strategyId,
      ticker,
      trigger: { fired: true, synthetic: true, source: "dev-trigger" },
      quantMetrics: { entry, stop },
    });

    const draft: ProposalDraft = {
      strategyId,
      signalId,
      ticker,
      side: "long",
      requestedQty: 100,
      entry,
      stop,
      exitPlan: { stopLoss: stop, rules: ["dev synthetic — exit at mean"] },
    };
    const decision = runtime.riskManager.evaluate(draft, {
      now,
      equity: await ctx.accountEquity(strategyId),
      executionTarget: runtime.executionTarget,
      openPositions: await ctx.openPositions(),
      killSwitchActive: await this.killSwitch.isActive(),
    });
    if (!decision.approved) {
      await this.riskEvents.persist(decision.event);
      return {
        kind: "risk-rejected",
        ticker,
        rule: decision.event.rule,
      };
    }

    const proposal: TradeProposal = { ...decision.proposal, signalId };
    return this.gateByMode(runtime, proposal, now);
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
    // Book any trades that closed (stop/target fills) before managing the rest,
    // so the governor's cap/cooldown state is current for this tick (T3.4).
    await this.reconcileAutoResults(strategyId);
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

  /**
   * Crowding stop-tightening pass (strategy #6, T2.4). For every open *long*
   * position on a currently-crowded ticker, emit a `modify-stop` suggestion that
   * halves the remaining risk (moves the stop halfway to entry). These are
   * advisory: they are journalled for the operator, not auto-applied — strategy
   * #6 runs WATCH-only, and tightening a live stop is a human call. Returns the
   * suggested actions (with the position) for the caller/tests.
   * @param strategyId - the strategy whose positions to scan
   */
  async suggestCrowdingStops(
    strategyId: string,
  ): Promise<Array<{ ticker: string; action: ExitAction }>> {
    const runtime = await this.registry.getRuntime(strategyId);
    if (!runtime) return [];
    const port = this.execPorts.portFor(runtime.executionTarget);
    const positions = await port.getPositions(strategyId);

    const suggestions: Array<{ ticker: string; action: ExitAction }> = [];
    for (const position of positions) {
      if (position.side !== "long" || position.stopPrice === undefined)
        continue;
      const status = await this.crowding.check(position.ticker);
      if (!status.crowded) continue;

      // Tighten the long stop halfway toward entry (never loosen it).
      const tightened =
        position.stopPrice + (position.avgEntryPrice - position.stopPrice) / 2;
      if (tightened <= position.stopPrice) continue;
      const newStopPrice = Math.round(tightened * 100) / 100;
      const action: ExitAction = {
        kind: "modify-stop",
        reason: "CROWDED_TICKER",
        newStopPrice,
      };

      await this.journal.append({
        strategyId,
        entryType: "decision",
        refType: "position",
        refId: position.id,
        title: `Crowding: suggest tightening ${position.ticker} stop → ${newStopPrice}`,
        body: status.evidence,
        meta: {
          reason: "CROWDED_TICKER",
          suggestion: "tighten-stop",
          fromStop: position.stopPrice,
          toStop: newStopPrice,
        },
      });
      suggestions.push({ ticker: position.ticker, action });
    }
    return suggestions;
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
