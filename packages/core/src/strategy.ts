/**
 * The strategy plugin contract (spec §3.1). Every strategy — momentum, pairs,
 * snapback, the crowding filter — implements this one interface, so the engine
 * runs them uniformly. The guiding principle: **the exit is written before the
 * entry** — `buildProposal` must always return a stop and an exit plan, and the
 * risk manager rejects anything without them.
 *
 * This is a behavioral interface (methods), so it has no zod schema; the
 * payloads its methods produce and consume are individually validated.
 */
import type { Mode, StrategyTimeframe } from "./enums.js";
import type { MarketContext, Ticker } from "./market.js";
import type { RiskParams } from "./risk.js";
import type { AnalysisRequest, LLMAnalysis, QuantSignal } from "./signal.js";
import type { ProposalDraft } from "./proposal.js";
import type { ExitAction, Position } from "./position.js";

/**
 * A pluggable trading strategy. The engine calls `universe`→`scan` on a
 * schedule, runs each signal through the LLM (`llmPrompt`) and risk manager,
 * turns survivors into orders via `buildProposal`, then calls `manage` on every
 * open position each bar.
 */
export interface Strategy {
  /** Stable id, e.g. "qual-sphb" (matches `strategies.id`). */
  readonly id: string;
  /** Human-readable name shown in the tab. */
  readonly name: string;
  /** Cadence/kind, driving scheduling and UI grouping. */
  readonly timeframe: StrategyTimeframe;
  /** Recommended starting mode (spec §3.2). */
  readonly defaultMode: Mode;
  /** Per-strategy risk overrides (tightening of the global ceilings). */
  readonly riskParams: RiskParams;

  /**
   * The set of symbols to scan this run.
   * @param ctx - read-only market/account context
   */
  universe(ctx: MarketContext): Promise<Ticker[]>;

  /**
   * Run the quant rules and emit a signal per trigger hit.
   * @param ctx - read-only market/account context
   */
  scan(ctx: MarketContext): Promise<QuantSignal[]>;

  /**
   * Describe what the LLM must verify for a signal (never sizes or prices).
   * @param signal - the quant signal to analyze
   */
  llmPrompt(signal: QuantSignal): AnalysisRequest;

  /**
   * Turn a proceed-verdict signal into a trade idea with entry, requested size,
   * stop, optional target and a written exit plan. The risk manager finalizes
   * sizing afterward.
   * @param signal - the triggering signal
   * @param analysis - the LLM's (proceed) analysis
   */
  buildProposal(signal: QuantSignal, analysis: LLMAnalysis): ProposalDraft;

  /**
   * Ongoing exit logic, called per bar for each open position. Return `null` to
   * hold, or an {@link ExitAction} to adjust/close.
   * @param position - the open position to manage
   * @param ctx - read-only market/account context
   */
  manage(position: Position, ctx: MarketContext): ExitAction | null;
}
