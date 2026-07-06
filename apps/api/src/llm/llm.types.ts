/**
 * Ports and DI tokens for the LLM analyst (spec §4.2, T1.5).
 *
 * The analyst is the only place a model touches a signal, and the cardinal
 * rule is fail-safe: a malformed, refused, or timed-out response is a **veto**,
 * never a pass. The service owns that guarantee; the collaborators below are
 * deliberately dumb — the transport just returns whatever the model produced
 * (or throws), and the repository just appends a row.
 */
import type { AnalysisRequest } from "@magpie/core";

/** DI token for the transport that actually calls Claude. */
export const LLM_ANALYST_CLIENT = Symbol("LLM_ANALYST_CLIENT");
/** DI token for the persistence sink for analyses. */
export const LLM_ANALYSIS_REPOSITORY = Symbol("LLM_ANALYSIS_REPOSITORY");

/** Hard wall-clock ceiling for a single analysis call (spec §4.2: 30s → veto). */
export const LLM_ANALYSIS_TIMEOUT_MS = 30_000;

/**
 * The raw, still-untrusted result of one model call. `candidate` is fed
 * straight into `parseLlmAnalysis`, which vetoes if it fails schema validation,
 * so the transport never has to reason about correctness — it only has to
 * report what the model said (and the model string / raw text for the audit).
 */
export interface LlmRawResult {
  /** The parsed-JSON object the model returned (or anything — validated later). */
  candidate: unknown;
  /** The verbatim response text, retained for the audit trail. */
  raw: string;
  /** The model id that produced it. */
  model: string;
}

/**
 * Transport port: given an analysis request, call the model and return its raw
 * output, or throw. Implementations must honor `signal` for cancellation so the
 * service's timeout can abort an in-flight request.
 */
export interface LlmAnalystClient {
  /** The configured model id (surfaced on veto rows even when the call throws). */
  readonly model: string;
  /**
   * Run one analysis. Must reject (not veto) on transport failure — the service
   * converts every failure into a veto so the policy lives in exactly one place.
   * @param request - what the model must verify (never sizes or prices)
   * @param signal - abort signal wired to the service-level timeout
   */
  analyze(request: AnalysisRequest, signal: AbortSignal): Promise<LlmRawResult>;
}

/** A single analysis ready to persist to `llm_analyses`. */
export interface PersistedAnalysis {
  signalId: string;
  verdict: "proceed" | "veto";
  confidence: number;
  reasoning: string;
  flaggedRisks: string[];
  rawResponse: string | null;
  latencyMs: number | null;
  model: string;
  /** Content hash of the request, for replay cache lookup (T3.1). */
  contextHash?: string | null;
}

/** Persistence port for the audit trail of analyses. */
export interface LlmAnalysisRepository {
  /**
   * Append one analysis row. Returns the new row id.
   * @param analysis - the validated (possibly veto) analysis to record
   */
  persist(analysis: PersistedAnalysis): Promise<{ id: string }>;
}
