import { describe, expect, it } from "vitest";
import {
  AnalysisRequestSchema,
  LLMAnalysisSchema,
  QuantSignalSchema,
  parseLlmAnalysis,
  vetoAnalysis,
} from "./signal.js";

describe("QuantSignalSchema", () => {
  it("accepts a well-formed signal and defaults quantMetrics", () => {
    const s = QuantSignalSchema.parse({
      strategyId: "qual-sphb",
      ticker: "QUAL",
      trigger: { kind: "crowding", z: 2.1 },
    });
    expect(s.quantMetrics).toEqual({});
  });

  it("rejects a non-numeric quant metric", () => {
    expect(() =>
      QuantSignalSchema.parse({
        strategyId: "qual-sphb",
        ticker: "QUAL",
        trigger: {},
        quantMetrics: { z: "high" },
      }),
    ).toThrow();
  });
});

describe("parseLlmAnalysis — fail-safe veto (spec §4.2)", () => {
  it("passes through a valid proceed verdict", () => {
    const a = parseLlmAnalysis({
      verdict: "proceed",
      confidence: 0.8,
      reasoning: "trend intact, no earnings nearby",
    });
    expect(a.verdict).toBe("proceed");
    expect(a.confidence).toBe(0.8);
  });

  it("vetoes on malformed input (missing verdict)", () => {
    const a = parseLlmAnalysis({ confidence: 0.9, reasoning: "looks good" });
    expect(a.verdict).toBe("veto");
    expect(a.confidence).toBe(0);
    expect(a.reasoning).toMatch(/malformed/);
  });

  it("vetoes on an out-of-range confidence", () => {
    const a = parseLlmAnalysis({
      verdict: "proceed",
      confidence: 1.7,
      reasoning: "very sure",
    });
    expect(a.verdict).toBe("veto");
  });

  it("vetoes on an invalid verdict value (never coerces to proceed)", () => {
    const a = parseLlmAnalysis({
      verdict: "YES_DEFINITELY",
      confidence: 1,
      reasoning: "",
    });
    expect(a.verdict).toBe("veto");
  });

  it.each([null, undefined, "not json", 42, [], NaN])(
    "vetoes on non-object input %p",
    (bad) => {
      expect(parseLlmAnalysis(bad).verdict).toBe("veto");
    },
  );

  it("attaches metadata on the veto path (timeout case)", () => {
    const a = parseLlmAnalysis(undefined, {
      model: "claude-opus-4-8",
      latencyMs: 30_000,
      raw: "<timed out>",
    });
    expect(a.verdict).toBe("veto");
    expect(a.model).toBe("claude-opus-4-8");
    expect(a.latencyMs).toBe(30_000);
  });

  it("lets caller metadata override a valid analysis' fields", () => {
    const a = parseLlmAnalysis(
      { verdict: "proceed", confidence: 0.5, reasoning: "ok" },
      { latencyMs: 1200 },
    );
    expect(a.verdict).toBe("proceed");
    expect(a.latencyMs).toBe(1200);
  });
});

describe("vetoAnalysis", () => {
  it("always produces a zero-confidence veto that re-validates", () => {
    const a = vetoAnalysis("kill switch active");
    expect(LLMAnalysisSchema.parse(a)).toEqual(a);
    expect(a.verdict).toBe("veto");
    expect(a.flaggedRisks).toContain("kill switch active");
  });
});

describe("AnalysisRequestSchema", () => {
  it("defaults webSearch on and context empty", () => {
    const r = AnalysisRequestSchema.parse({
      strategyId: "qual-sphb",
      ticker: "QUAL",
      prompt: "any adverse catalysts in the next 5 days?",
    });
    expect(r.webSearch).toBe(true);
    expect(r.context).toEqual({});
    expect(r.requiredChecks).toEqual([]);
  });
});
