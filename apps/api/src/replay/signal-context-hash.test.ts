import { describe, it, expect } from "vitest";
import {
  analysisContextHash,
  canonicalJson,
  fnv1a,
  hashUnitInterval,
  signalContextHash,
  type AnalysisContext,
} from "./signal-context-hash.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively so order never changes the encoding", () => {
    const a = canonicalJson({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("preserves array order (arrays are meaningful sequences)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("handles null and primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("x")).toBe('"x"');
  });
});

describe("fnv1a", () => {
  it("is deterministic and returns 8 hex chars", () => {
    const h = fnv1a("magpie");
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("magpie")).toBe(h);
  });

  it("separates distinct inputs", () => {
    expect(fnv1a("a")).not.toBe(fnv1a("b"));
  });
});

describe("signalContextHash", () => {
  it("is stable regardless of trigger/metric key order", () => {
    const one = signalContextHash({
      strategyId: "s",
      ticker: "AAA",
      trigger: { z: 1, a: 2 },
      quantMetrics: { beta: 2, alpha: 1 },
    });
    const two = signalContextHash({
      strategyId: "s",
      ticker: "AAA",
      trigger: { a: 2, z: 1 },
      quantMetrics: { alpha: 1, beta: 2 },
    });
    expect(one).toBe(two);
  });

  it("changes when any context field changes", () => {
    const base = {
      strategyId: "s",
      ticker: "AAA",
      trigger: { k: 1 },
      quantMetrics: { m: 1 },
    };
    const h = signalContextHash(base);
    expect(signalContextHash({ ...base, ticker: "BBB" })).not.toBe(h);
    expect(signalContextHash({ ...base, strategyId: "t" })).not.toBe(h);
    expect(signalContextHash({ ...base, quantMetrics: { m: 2 } })).not.toBe(h);
  });
});

describe("hashUnitInterval", () => {
  it("maps every 8-hex hash into [0, 1)", () => {
    for (const s of ["00000000", "ffffffff", "7fffffff", "deadbeef"]) {
      const v = hashUnitInterval(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(hashUnitInterval("00000000")).toBe(0);
  });

  it("is deterministic for a given hash", () => {
    expect(hashUnitInterval("deadbeef")).toBe(hashUnitInterval("deadbeef"));
  });
});

describe("analysisContextHash", () => {
  const req: AnalysisContext = {
    strategyId: "earnings-fade",
    ticker: "NVDA",
    prompt: "Is the post-earnings gap fadeable?",
    context: { gapPct: 8, z: 2.1 },
    requiredChecks: ["no guidance cut", "no analyst upgrades"],
    webSearch: true,
  };

  it("hashes identical requests identically (the cache key)", () => {
    expect(analysisContextHash(req)).toBe(analysisContextHash({ ...req }));
  });

  it("is invariant to context key order", () => {
    const reordered: AnalysisContext = {
      ...req,
      context: { z: 2.1, gapPct: 8 },
    };
    expect(analysisContextHash(reordered)).toBe(analysisContextHash(req));
  });

  it("distinguishes a different prompt or ticker (a different question)", () => {
    expect(analysisContextHash({ ...req, prompt: "other" })).not.toBe(
      analysisContextHash(req),
    );
    expect(analysisContextHash({ ...req, ticker: "AMD" })).not.toBe(
      analysisContextHash(req),
    );
  });
});
