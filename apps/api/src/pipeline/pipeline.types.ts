/**
 * Ports and DI tokens for the signal pipeline orchestrator (spec §4.2, T1.6).
 *
 * The orchestrator is deliberately I/O-free: it wires together a strategy's
 * `scan`/`buildProposal`/`manage`, the LLM analyst, the crowding hook, the risk
 * manager, an execution port and a set of persistence sinks — all behind the
 * ports below — so the whole mode-gate flow can be integration-tested with
 * in-memory fakes (T1.6 AC) and swapped for Drizzle/BullMQ in production.
 */
import type {
  AnalysisRequest,
  DecidedBy,
  ExecutionPort,
  ExecutionTarget,
  LLMAnalysis,
  MarketContext,
  Mode,
  QuantSignal,
  RiskEvent,
  RiskManager,
  Strategy,
  TradeProposal,
  Ticker,
} from "@magpie/core";

/** DI tokens. */
export const STRATEGY_REGISTRY = Symbol("STRATEGY_REGISTRY");
export const LLM_ANALYST = Symbol("LLM_ANALYST");
export const SIGNAL_STORE = Symbol("SIGNAL_STORE");
export const PROPOSAL_STORE = Symbol("PROPOSAL_STORE");
export const RISK_EVENT_STORE = Symbol("RISK_EVENT_STORE");
export const JOURNAL_SINK = Symbol("JOURNAL_SINK");
export const PIPELINE_AUDIT_SINK = Symbol("PIPELINE_AUDIT_SINK");
export const PROPOSAL_NOTIFIER = Symbol("PROPOSAL_NOTIFIER");
export const CROWDING_FILTER = Symbol("CROWDING_FILTER");
export const MARKET_CONTEXT_PROVIDER = Symbol("MARKET_CONTEXT_PROVIDER");
export const EXECUTION_PORT_PROVIDER = Symbol("EXECUTION_PORT_PROVIDER");
export const KILL_SWITCH_GATE = Symbol("KILL_SWITCH_GATE");
export const BRACKET_INDEX = Symbol("BRACKET_INDEX");
export const PIPELINE_CLOCK = Symbol("PIPELINE_CLOCK");

/**
 * A resolved, runnable strategy: the plugin instance plus its live operating
 * mode, the rung it trades, and the risk manager built from its risk params.
 */
export interface StrategyRuntime {
  readonly strategy: Strategy;
  readonly mode: Mode;
  readonly executionTarget: ExecutionTarget;
  readonly riskManager: RiskManager;
}

/** Resolves strategy runtimes (code instance ⋈ DB mode/target/risk). */
export interface StrategyRegistry {
  getRuntime(strategyId: string): Promise<StrategyRuntime | undefined>;
  all(): Promise<StrategyRuntime[]>;
}

/**
 * The LLM analyst as the pipeline sees it — a shared, stateless verifier. Its
 * only guarantee is fail-safe: it never throws, returning a veto on any
 * failure (the real impl is `LlmAnalystService`).
 */
export interface LlmAnalyst {
  analyze(request: AnalysisRequest): Promise<LLMAnalysis>;
}

/** Persists a quant signal, returning its new id. */
export interface SignalStore {
  persist(signal: QuantSignal): Promise<{ id: string }>;
}

/** A pending proposal awaiting the TTL sweep. */
export interface PendingProposal {
  readonly id: string;
  readonly strategyId: string;
  readonly expiry: Date;
  /** Snapshot for the audit `before` image. */
  readonly snapshot: Record<string, unknown>;
}

/** A persisted proposal with its id guaranteed present (as read back). */
export type StoredProposal = TradeProposal & { id: string };

/** Persists proposals and drives their lifecycle transitions. */
export interface ProposalStore {
  persist(proposal: TradeProposal): Promise<{ id: string }>;
  /**
   * Mark a proposal executed. `decidedBy` records whether AUTO mode or a human
   * approval drove it; `finalQty`, when given, records the (downward-adjusted)
   * approved size onto the row.
   */
  markExecuted(
    id: string,
    at: Date,
    decidedBy?: DecidedBy,
    finalQty?: number,
  ): Promise<void>;
  /** Mark a pending proposal rejected by a human (guarded on `pending`). */
  reject(id: string, at: Date): Promise<void>;
  /** Load one proposal by id, or `null` when it does not exist. */
  get(id: string): Promise<StoredProposal | null>;
  /** Full pending proposals for the approval surface (REST/Telegram/WS). */
  listPendingDetailed(): Promise<StoredProposal[]>;
  listPending(): Promise<PendingProposal[]>;
  expire(id: string, at: Date): Promise<void>;
}

/** Persists risk-rule events (rejections and trips). */
export interface RiskEventStore {
  persist(event: RiskEvent, proposalId?: string): Promise<void>;
}

/** A single journal line (spec §7 `journal_entries`). */
export interface JournalEntry {
  strategyId?: string;
  entryType: "decision" | "note";
  refType?: string;
  refId?: string;
  title: string;
  body?: string;
  meta?: Record<string, unknown>;
}

/** Append-only journal for auto-decisions and notes. */
export interface JournalSink {
  append(entry: JournalEntry): Promise<void>;
}

/** One append-only audit record of a money-path state change (spec §7). */
export interface PipelineAuditEntry {
  entityType: string;
  entityId: string;
  action: string;
  actor: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** Append-only audit sink. */
export interface PipelineAuditSink {
  append(entry: PipelineAuditEntry): Promise<void>;
}

/** Notifies a decision-maker that a proposal needs approval (APPROVE mode). */
export interface ProposalNotifier {
  proposalPending(proposal: TradeProposal & { id: string }): Promise<void>;
}

/**
 * Crowding filter hook (spec §4.2 step). A no-op in T1.6 (always false);
 * strategy #6 later backs it with the `crowded_tickers` evidence store.
 */
export interface CrowdingFilter {
  isCrowded(ticker: Ticker): Promise<boolean>;
}

/** Builds the read-only market context for a run on a given rung. */
export interface MarketContextProvider {
  contextFor(target: ExecutionTarget, now: Date): Promise<MarketContext>;
}

/** Supplies the execution port for a rung (SIM in the MVP). */
export interface ExecutionPortProvider {
  portFor(target: ExecutionTarget): ExecutionPort;
}

/** Reports whether the global kill switch is currently tripped. */
export interface KillSwitchGate {
  isActive(): Promise<boolean>;
}

/**
 * Correlates an open position back to its working bracket so the monitor can
 * modify/cancel it. SIM brackets live in-process in the Simulator and carry no
 * id on the emitted `Position`, so the pipeline records the mapping at
 * placement time. Keyed by `strategyId:ticker` (no averaging-down ⇒ at most one
 * open bracket per key).
 */
export interface BracketIndex {
  record(strategyId: string, ticker: Ticker, bracketId: string): void;
  resolve(strategyId: string, ticker: Ticker): string | undefined;
  clear(strategyId: string, ticker: Ticker): void;
}

/** Injectable clock so proposal expiry is deterministic in tests. */
export interface Clock {
  now(): Date;
}
