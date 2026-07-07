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

/** One web-search invocation the model made during a call (U1 dialog log). */
export interface WebSearchInvocation {
  /** The search query the model issued. */
  query: string;
}

/**
 * The request side of one model call, captured deterministically for the dialog
 * log (U1). Holds exactly what was sent — never any secret (the API key lives in
 * the SDK client, never in these fields).
 */
export interface LlmCallDescription {
  /** Verbatim system prompt. */
  systemPrompt: string;
  /** Verbatim user-turn text. */
  userPrompt: string;
  /** Request params (model, max_tokens, web-search enabled, …) — no secrets. */
  params: Record<string, unknown>;
}

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
  /** Web-search invocations the model made, if the SDK surfaced any. */
  webSearches: WebSearchInvocation[] | null;
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
  /**
   * Describe the request that {@link analyze} would send, without calling the
   * model. Lets the service log the exact prompt even when the call fails.
   * @param request - what the model must verify (never sizes or prices)
   */
  describeCall(request: AnalysisRequest): LlmCallDescription;
}

/**
 * A single analysis ready to persist to `llm_analyses` (U1: the full dialog).
 * `signalId`/`verdict`/`confidence` are nullable because the crowding scan and
 * failed calls have none.
 */
export interface PersistedAnalysis {
  /** signal_analysis | crowding_scan. */
  purpose: "signal_analysis" | "crowding_scan";
  signalId: string | null;
  strategyId: string | null;
  ticker: string | null;
  verdict: "proceed" | "veto" | null;
  /** What actually happened — always set. */
  outcome: "proceed" | "veto" | "veto_by_failure";
  confidence: number | null;
  reasoning: string | null;
  flaggedRisks: string[];
  systemPrompt: string | null;
  userPrompt: string | null;
  params: Record<string, unknown> | null;
  webSearches: WebSearchInvocation[] | null;
  rawResponse: string | null;
  /** Error text when `outcome === "veto_by_failure"`. */
  errorText: string | null;
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
