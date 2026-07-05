/**
 * The LLM analyst service (spec §4.2, T1.5).
 *
 * This is the single trust boundary for model output. It calls the transport
 * under a hard 30s wall-clock timeout and converts EVERY failure mode —
 * timeout, transport error, refusal, malformed JSON, schema violation — into a
 * deterministic **veto** via `@magpie/core`'s `vetoAnalysis` / `parseLlmAnalysis`.
 * The money path can therefore never mistake a broken analysis for a pass.
 *
 * Purity note: latency uses `Date.now()` here (an app-layer concern); the core
 * money path stays clock-free for deterministic replay.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  parseLlmAnalysis,
  vetoAnalysis,
  type AnalysisRequest,
  type LLMAnalysis,
} from "@magpie/core";
import {
  LLM_ANALYSIS_REPOSITORY,
  LLM_ANALYSIS_TIMEOUT_MS,
  LLM_ANALYST_CLIENT,
  type LlmAnalysisRepository,
  type LlmAnalystClient,
} from "./llm.types.js";

/** Raised by the wall-clock guard when the model call overruns the ceiling. */
class AnalysisTimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM analysis timed out after ${ms}ms`);
    this.name = "AnalysisTimeoutError";
  }
}

/** Turn any thrown value into a short, audit-friendly veto reason. */
function describeError(err: unknown): string {
  if (err instanceof Error)
    return `LLM analysis failed: ${err.name}: ${err.message}`;
  return `LLM analysis failed: ${String(err)}`;
}

@Injectable()
export class LlmAnalystService {
  private readonly logger = new Logger(LlmAnalystService.name);

  constructor(
    @Inject(LLM_ANALYST_CLIENT) private readonly client: LlmAnalystClient,
    @Inject(LLM_ANALYSIS_REPOSITORY)
    private readonly repo: LlmAnalysisRepository,
  ) {}

  /**
   * Analyze one signal and return a trusted verdict. Never throws for a model
   * or transport problem — those become vetoes. Persists the result to
   * `llm_analyses` when the request carries a persisted `signalId`.
   *
   * @param request - what the model must verify (never sizes or prices)
   */
  async analyze(request: AnalysisRequest): Promise<LLMAnalysis> {
    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AnalysisTimeoutError(LLM_ANALYSIS_TIMEOUT_MS));
      }, LLM_ANALYSIS_TIMEOUT_MS);
    });

    let analysis: LLMAnalysis;
    try {
      const rawResult = await Promise.race([
        this.client.analyze(request, controller.signal),
        timeout,
      ]);
      analysis = parseLlmAnalysis(rawResult.candidate, {
        model: rawResult.model,
        latencyMs: Date.now() - started,
        raw: rawResult.raw,
      });
    } catch (err) {
      controller.abort();
      const reason = describeError(err);
      this.logger.warn(`${request.ticker}: ${reason} → veto`);
      analysis = vetoAnalysis(reason, {
        model: this.client.model,
        latencyMs: Date.now() - started,
      });
    } finally {
      clearTimeout(timer);
    }

    await this.persistSafely(request, analysis);
    return analysis;
  }

  /**
   * Record the analysis, tolerating a persistence failure (logged, not thrown)
   * so a DB hiccup can never flip a verdict or crash the pipeline. Skips
   * persistence for un-persisted signals (no FK to satisfy).
   */
  private async persistSafely(
    request: AnalysisRequest,
    analysis: LLMAnalysis,
  ): Promise<void> {
    if (!request.signalId) {
      this.logger.debug(
        `${request.ticker}: no signalId, skipping analysis persistence`,
      );
      return;
    }
    try {
      await this.repo.persist({
        signalId: request.signalId,
        verdict: analysis.verdict,
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
        flaggedRisks: analysis.flaggedRisks,
        rawResponse: analysis.raw ?? null,
        latencyMs: analysis.latencyMs ?? null,
        model: analysis.model ?? this.client.model,
      });
    } catch (err) {
      this.logger.error(
        `failed to persist analysis for ${request.ticker}: ${describeError(err)}`,
      );
    }
  }
}
