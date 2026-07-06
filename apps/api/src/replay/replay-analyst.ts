/**
 * The replay LLM analyst (T3.1). In replay we never call Claude. Instead this
 * fail-safe {@link LlmAnalyst} either:
 *
 *   1. **replays a cached verdict** — when a prior run analysed the same signal
 *      context (`analysisContextHash`), its `llm_analyses` row is reused, so a
 *      backtest reflects what the model actually decided; or
 *   2. **synthesizes a stub** — on a cache miss it draws proceed/veto by a fixed
 *      pass-rate, seeded deterministically from the context hash (never a clock
 *      or RNG), and flags the verdict `replayStubbed: true` so reports never
 *      mistake a synthetic pass for a real one.
 *
 * Determinism is the whole point: same signals → same hashes → same cache hits
 * and same stub draws → identical trades on every replay (T3.1 AC1).
 *
 * Like the live analyst it never throws — the pipeline treats a bad analysis as
 * a veto, and a stub is a deliberate, auditable decision, not a failure.
 */
import { Injectable, Logger } from "@nestjs/common";
import type { AnalysisRequest, LLMAnalysis } from "@magpie/core";
import type { LlmAnalyst } from "../pipeline/pipeline.types.js";
import {
  analysisContextHash,
  hashUnitInterval,
} from "./signal-context-hash.js";

/**
 * Read-through source of previously-recorded analyses, keyed by the request's
 * content hash. The production impl queries `llm_analyses`; tests use an
 * in-memory map. Returns `null` on a miss (→ the engine stubs).
 */
export interface AnalysisCache {
  lookup(contextHash: string): Promise<LLMAnalysis | null>;
}

/** Tuning for the stub path — how generous the synthetic pass-rate is. */
export interface ReplayAnalystOptions {
  /**
   * Fraction of cache-missed signals that stub to `proceed`, in [0, 1]. The
   * draw is deterministic per signal, so this sets the *set* of signals that
   * pass, not a random rate. Defaults to 0.7.
   */
  readonly stubPassRate: number;
}

const DEFAULT_OPTIONS: ReplayAnalystOptions = { stubPassRate: 0.7 };

/** An empty cache — every lookup misses (pure-stub replay). */
export class NullAnalysisCache implements AnalysisCache {
  async lookup(): Promise<LLMAnalysis | null> {
    return null;
  }
}

/** A seedable in-memory cache for tests and single-run backtests. */
export class InMemoryAnalysisCache implements AnalysisCache {
  private readonly byHash = new Map<string, LLMAnalysis>();

  /** Record a verdict under a request's content hash. */
  put(request: AnalysisRequest, analysis: LLMAnalysis): void {
    this.byHash.set(analysisContextHash(request), analysis);
  }

  async lookup(contextHash: string): Promise<LLMAnalysis | null> {
    return this.byHash.get(contextHash) ?? null;
  }
}

@Injectable()
export class ReplayLlmAnalyst implements LlmAnalyst {
  private readonly logger = new Logger(ReplayLlmAnalyst.name);
  private readonly passRate: number;

  constructor(
    private readonly cache: AnalysisCache,
    options: Partial<ReplayAnalystOptions> = {},
  ) {
    const rate = options.stubPassRate ?? DEFAULT_OPTIONS.stubPassRate;
    // Clamp defensively so a mis-set config can't poison determinism math.
    this.passRate = Math.min(1, Math.max(0, rate));
  }

  async analyze(request: AnalysisRequest): Promise<LLMAnalysis> {
    const hash = analysisContextHash(request);
    const cached = await this.cache.lookup(hash);
    if (cached) {
      // A real recorded verdict — mark it explicitly not-stubbed for reports.
      return { ...cached, replayStubbed: false };
    }
    return this.stub(request, hash);
  }

  /** Deterministic proceed/veto for a signal with no recorded analysis. */
  private stub(request: AnalysisRequest, hash: string): LLMAnalysis {
    const draw = hashUnitInterval(hash);
    const proceed = draw < this.passRate;
    this.logger.debug(
      `${request.ticker}: no cached analysis (${hash}); stub draw=${draw.toFixed(
        4,
      )} passRate=${this.passRate} → ${proceed ? "proceed" : "veto"}`,
    );
    return {
      verdict: proceed ? "proceed" : "veto",
      // Confidence encodes how far the draw sat from the decision boundary.
      confidence: proceed
        ? this.passRate
        : Math.min(1, 1 - this.passRate + (draw - this.passRate)),
      reasoning: proceed
        ? `Replay stub: no cached analysis for ${request.ticker}; synthesized proceed at pass-rate ${this.passRate}.`
        : `Replay stub: no cached analysis for ${request.ticker}; synthesized veto at pass-rate ${this.passRate}.`,
      flaggedRisks: proceed ? [] : ["replay-stubbed veto (no cached analysis)"],
      replayStubbed: true,
    };
  }
}
