/**
 * Strategy #6 (AI-crowding filter) supporting types (T2.4). The nightly research
 * job compiles the currently over-recommended ("crowded") tickers with evidence
 * into the `crowded_tickers` store; the pipeline's {@link CrowdingFilter} reads
 * that store to veto new-long entries and suggest tighter stops.
 */

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
 * Compiles the current crowded-ticker set. The production implementation asks an
 * LLM with web search "which tickers are over-recommended right now?"; tests and
 * offline runs use a static list. Kept behind an interface so the nightly job is
 * deterministic and testable without a live model.
 */
export interface CrowdingResearcher {
  research(): Promise<CrowdedTickerEvidence[]>;
}

/** DI token for the {@link CrowdingResearcher}. */
export const CROWDING_RESEARCHER = Symbol("CROWDING_RESEARCHER");
