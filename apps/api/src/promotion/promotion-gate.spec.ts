/**
 * Promotion gate math (T2.2 AC: "unit tests for gate math"). The gate is pure,
 * so every ladder case — no-op, demotion, LIVE lock, missing note, too few
 * trades, and the happy path — is asserted here in isolation.
 */
import { describe, expect, it } from "vitest";
import {
  classifyTargetChange,
  evaluatePromotionGate,
  PROMOTION_MIN_CLOSED_TRADES,
} from "./promotion-gate.js";

describe("classifyTargetChange", () => {
  it("orders the ladder SIM < PAPER < LIVE", () => {
    expect(classifyTargetChange("SIM", "PAPER")).toBe("promotion");
    expect(classifyTargetChange("PAPER", "LIVE")).toBe("promotion");
    expect(classifyTargetChange("SIM", "LIVE")).toBe("promotion");
    expect(classifyTargetChange("PAPER", "SIM")).toBe("demotion");
    expect(classifyTargetChange("LIVE", "PAPER")).toBe("demotion");
    expect(classifyTargetChange("PAPER", "PAPER")).toBe("none");
  });

  it("throws on an unknown target", () => {
    expect(() => classifyTargetChange("SIM", "BOGUS")).toThrow(/unknown/);
  });
});

describe("evaluatePromotionGate", () => {
  it("allows a same-rung (mode-only) change with no note or trades", () => {
    expect(
      evaluatePromotionGate({ from: "SIM", to: "SIM", closedTrades: 0 }),
    ).toEqual({ allowed: true, direction: "none" });
  });

  it("always allows a demotion, no note or trades required", () => {
    expect(
      evaluatePromotionGate({ from: "PAPER", to: "SIM", closedTrades: 0 }),
    ).toEqual({ allowed: true, direction: "demotion" });
  });

  it("locks promotion to LIVE regardless of trades or note (rule 6)", () => {
    const d = evaluatePromotionGate({
      from: "PAPER",
      to: "LIVE",
      closedTrades: 9999,
      note: "ready for live",
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("LIVE_LOCKED");
  });

  it("requires a review note for a promotion", () => {
    const d = evaluatePromotionGate({
      from: "SIM",
      to: "PAPER",
      closedTrades: 100,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("NOTE_REQUIRED");
  });

  it("treats a whitespace-only note as missing", () => {
    const d = evaluatePromotionGate({
      from: "SIM",
      to: "PAPER",
      closedTrades: 100,
      note: "   ",
    });
    expect(d.code).toBe("NOTE_REQUIRED");
  });

  it("rejects a promotion below the closed-trade threshold", () => {
    const d = evaluatePromotionGate({
      from: "SIM",
      to: "PAPER",
      closedTrades: PROMOTION_MIN_CLOSED_TRADES - 1,
      note: "let me in",
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("INSUFFICIENT_TRADES");
    expect(d.required).toBe(PROMOTION_MIN_CLOSED_TRADES);
  });

  it("allows a promotion at exactly the threshold with a note", () => {
    const d = evaluatePromotionGate({
      from: "SIM",
      to: "PAPER",
      closedTrades: PROMOTION_MIN_CLOSED_TRADES,
      note: "30 clean SIM trades, ready to paper",
    });
    expect(d).toEqual({ allowed: true, direction: "promotion" });
  });

  it("honors a custom minTrades override", () => {
    const d = evaluatePromotionGate({
      from: "SIM",
      to: "PAPER",
      closedTrades: 5,
      note: "small-sample test",
      minTrades: 5,
    });
    expect(d.allowed).toBe(true);
  });
});
