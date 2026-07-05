/**
 * Quant signals and the LLM analysis contract (spec §3.1, §4.2). All three
 * types cross a boundary: `QuantSignal` is persisted to `signals`,
 * `AnalysisRequest` is sent to the LLM analyst process, and `LLMAnalysis` is the
 * LLM's *untrusted* response persisted to `llm_analyses`. The cardinal rule
 * (spec §4.2, §10): a malformed or timed-out analysis is a **veto**, never a
 * pass — enforced by {@link parseLlmAnalysis}.
 */
import { z } from "zod";
import { TickerSchema } from "./market.js";
import { VerdictSchema } from "./enums.js";

/**
 * Output of a strategy's `scan` — one quant trigger hit for one ticker. The
 * `trigger` and `quantMetrics` bags are strategy-specific and stored as jsonb;
 * they must be JSON-serializable and must never contain sizing or order params
 * (the risk manager owns those).
 */
export const QuantSignalSchema = z.object({
  /** DB id, absent until persisted. */
  id: z.string().uuid().optional(),
  /** Strategy that produced the signal. */
  strategyId: z.string().min(1),
  /** Symbol the signal fired on. */
  ticker: TickerSchema,
  /** Structured trigger description (why it fired) — persisted as jsonb. */
  trigger: z.record(z.unknown()),
  /** Numeric quant metrics (ratios, z-scores, …) — persisted as jsonb. */
  quantMetrics: z.record(z.number()).default({}),
  /** Creation time, assigned by the DB when absent. */
  createdAt: z.coerce.date().optional(),
});
/** One quant trigger hit awaiting LLM analysis and risk finalization. */
export type QuantSignal = z.infer<typeof QuantSignalSchema>;

/**
 * What a strategy asks the LLM to verify for a given signal (spec §3.1
 * `llmPrompt`). The analyst turns this into a Claude call with web search; it
 * decides only proceed/veto and never sees or sets numbers.
 */
export const AnalysisRequestSchema = z.object({
  /** Strategy requesting the check. */
  strategyId: z.string().min(1),
  /** Symbol under analysis. */
  ticker: TickerSchema,
  /** Signal being analyzed, when it has been persisted. */
  signalId: z.string().uuid().optional(),
  /** The question/prompt the analyst must answer (from `Strategy.llmPrompt`). */
  prompt: z.string().min(1),
  /** Extra structured context for the prompt (quant metrics, dates, …). */
  context: z.record(z.unknown()).default({}),
  /** Explicit checklist the analyst must address (surfaced in the tab log). */
  requiredChecks: z.array(z.string()).default([]),
  /** Whether the analyst should use the web-search tool for this request. */
  webSearch: z.boolean().default(true),
});
/** A structured request for the LLM analyst to verify a signal. */
export type AnalysisRequest = z.infer<typeof AnalysisRequestSchema>;

/**
 * The LLM analyst's structured verdict (spec §4.2). This is untrusted input:
 * schema-validated, capped at proceed/veto, never interpolated into orders.
 * `confidence` is 0..1; `flaggedRisks` is a human-readable list surfaced in the
 * signal log.
 */
export const LLMAnalysisSchema = z.object({
  /** proceed or veto — the only authority the LLM has. */
  verdict: VerdictSchema,
  /** Model's self-reported confidence in [0, 1]. */
  confidence: z.number().min(0).max(1),
  /** Free-text reasoning shown to the user. */
  reasoning: z.string(),
  /** Named risks the model flagged (e.g. "earnings in 2 days"). */
  flaggedRisks: z.array(z.string()).default([]),
  /** Model identifier that produced the verdict. */
  model: z.string().optional(),
  /** End-to-end latency of the analysis call, in ms. */
  latencyMs: z.number().int().nonnegative().optional(),
  /** Raw response text, retained for audit. */
  raw: z.string().optional(),
});
/** A validated LLM analysis result. */
export type LLMAnalysis = z.infer<typeof LLMAnalysisSchema>;

/**
 * Build a deterministic veto analysis. Used whenever the LLM output cannot be
 * trusted — parse failure, timeout, or transport error — so the pipeline fails
 * safe (spec §4.2: "treated as a veto, never a pass").
 *
 * @param reason - human-readable reason recorded on the analysis
 * @param extra - optional fields to attach (model, latency, raw)
 */
export function vetoAnalysis(
  reason: string,
  extra: Partial<Pick<LLMAnalysis, "model" | "latencyMs" | "raw">> = {},
): LLMAnalysis {
  return {
    verdict: "veto",
    confidence: 0,
    reasoning: reason,
    flaggedRisks: [reason],
    ...extra,
  };
}

/**
 * Safely parse an untrusted LLM response into an {@link LLMAnalysis}. On any
 * validation failure this returns a {@link vetoAnalysis} rather than throwing,
 * guaranteeing the money path can never mistake malformed output for a pass.
 *
 * @param input - the parsed-JSON candidate from the model (or anything)
 * @param extra - optional metadata to attach on the veto path (model, latency, raw)
 * @returns a trusted analysis — the model's verdict if valid, else a veto
 */
export function parseLlmAnalysis(
  input: unknown,
  extra: Partial<Pick<LLMAnalysis, "model" | "latencyMs" | "raw">> = {},
): LLMAnalysis {
  const result = LLMAnalysisSchema.safeParse(input);
  if (!result.success) {
    return vetoAnalysis(
      `malformed LLM analysis: ${result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      extra,
    );
  }
  return { ...result.data, ...extra };
}
