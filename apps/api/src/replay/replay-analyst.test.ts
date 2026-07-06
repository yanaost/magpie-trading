import { describe, it, expect } from "vitest";
import type { AnalysisRequest, LLMAnalysis } from "@magpie/core";
import {
  InMemoryAnalysisCache,
  NullAnalysisCache,
  ReplayLlmAnalyst,
} from "./replay-analyst.js";

function req(overrides: Partial<AnalysisRequest> = {}): AnalysisRequest {
  return {
    strategyId: "earnings-fade",
    ticker: "NVDA",
    prompt: "Is the gap fadeable?",
    context: {},
    requiredChecks: [],
    webSearch: true,
    ...overrides,
  };
}

const REAL: LLMAnalysis = {
  verdict: "proceed",
  confidence: 0.9,
  reasoning: "recorded verdict",
  flaggedRisks: [],
  model: "claude-opus-4-8",
};

describe("ReplayLlmAnalyst — cache replay", () => {
  it("returns a cached verdict marked not-stubbed", async () => {
    const cache = new InMemoryAnalysisCache();
    const r = req();
    cache.put(r, REAL);
    const analyst = new ReplayLlmAnalyst(cache);

    const out = await analyst.analyze(r);
    expect(out.verdict).toBe("proceed");
    expect(out.reasoning).toBe("recorded verdict");
    expect(out.replayStubbed).toBe(false);
  });

  it("misses when the context differs, then stubs", async () => {
    const cache = new InMemoryAnalysisCache();
    cache.put(req({ ticker: "NVDA" }), REAL);
    const analyst = new ReplayLlmAnalyst(cache, { stubPassRate: 1 });

    const out = await analyst.analyze(req({ ticker: "AMD" }));
    expect(out.replayStubbed).toBe(true);
  });
});

describe("ReplayLlmAnalyst — deterministic stub", () => {
  it("stubs the same verdict for the same signal every time", async () => {
    const analyst = new ReplayLlmAnalyst(new NullAnalysisCache(), {
      stubPassRate: 0.7,
    });
    const first = await analyst.analyze(req({ ticker: "TSLA" }));
    const second = await analyst.analyze(req({ ticker: "TSLA" }));
    expect(second).toEqual(first);
    expect(first.replayStubbed).toBe(true);
  });

  it("passRate 1 always proceeds, passRate 0 always vetoes", async () => {
    const always = new ReplayLlmAnalyst(new NullAnalysisCache(), {
      stubPassRate: 1,
    });
    const never = new ReplayLlmAnalyst(new NullAnalysisCache(), {
      stubPassRate: 0,
    });
    for (const t of ["A", "B", "C", "D", "E"]) {
      expect((await always.analyze(req({ ticker: t }))).verdict).toBe(
        "proceed",
      );
      expect((await never.analyze(req({ ticker: t }))).verdict).toBe("veto");
    }
  });

  it("splits a population of signals roughly by the pass-rate", async () => {
    const analyst = new ReplayLlmAnalyst(new NullAnalysisCache(), {
      stubPassRate: 0.5,
    });
    let proceed = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const out = await analyst.analyze(
        req({ ticker: `T${i}`, prompt: `p${i}` }),
      );
      if (out.verdict === "proceed") proceed++;
    }
    // Deterministic hashing, but over many distinct signals it should land near
    // the configured rate (loose bounds — this is a sanity check, not an RNG).
    expect(proceed).toBeGreaterThan(N * 0.3);
    expect(proceed).toBeLessThan(N * 0.7);
  });

  it("always yields a confidence within [0, 1]", async () => {
    const analyst = new ReplayLlmAnalyst(new NullAnalysisCache(), {
      stubPassRate: 0.7,
    });
    for (let i = 0; i < 50; i++) {
      const out = await analyst.analyze(req({ ticker: `X${i}` }));
      expect(out.confidence).toBeGreaterThanOrEqual(0);
      expect(out.confidence).toBeLessThanOrEqual(1);
    }
  });
});
