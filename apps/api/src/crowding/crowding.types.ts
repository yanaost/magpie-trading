/**
 * Strategy #6 (AI-crowding filter) supporting types (T2.4). The nightly research
 * job compiles the currently over-recommended ("crowded") tickers with evidence
 * into the `crowded_tickers` store; the pipeline's {@link CrowdingFilter} reads
 * that store to veto new-long entries and suggest tighter stops.
 */
import type { WebSearchInvocation } from "../llm/llm.types.js";

/** Days a crowded-ticker flag stays live before it expires (spec §7). */
export const CROWDING_TTL_DAYS = 30;

/** One flagged ticker and the evidence that it is over-recommended. */
export interface CrowdedTickerEvidence {
  /** Symbol, upper-cased. */
  readonly ticker: string;
  /** Short human-readable justification (headline / source summary). */
  readonly evidence: string;
}

/**
 * The full dialog of one crowding-research call, for the LLM log (U1). Mirrors
 * the analyst's dialog capture. `rawResponse`/`webSearches` are null on the
 * request-only description used to log a failed call.
 */
export interface CrowdingDialog {
  systemPrompt: string;
  userPrompt: string;
  params: Record<string, unknown>;
  model: string;
  rawResponse: string | null;
  webSearches: WebSearchInvocation[] | null;
}

/** Result of one research run: the tickers plus the dialog to log (U1). */
export interface CrowdingResearchResult {
  tickers: CrowdedTickerEvidence[];
  /** The dialog to record, or null for the offline/null researcher. */
  dialog: CrowdingDialog | null;
}

/**
 * Compiles the current crowded-ticker set. The production implementation asks an
 * LLM with web search "which tickers are over-recommended right now?"; tests and
 * offline runs use a static list. Kept behind an interface so the nightly job is
 * deterministic and testable without a live model.
 */
export interface CrowdingResearcher {
  research(): Promise<CrowdingResearchResult>;
  /**
   * Describe the request {@link research} would send, without calling the model,
   * so the refresh job can log the exact prompt even when the call fails.
   */
  describeCall(): CrowdingDialog;
}

/** DI token for the {@link CrowdingResearcher}. */
export const CROWDING_RESEARCHER = Symbol("CROWDING_RESEARCHER");
