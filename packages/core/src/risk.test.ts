import { describe, expect, it } from "vitest";
import {
  DEFAULT_RISK_PARAMS,
  GLOBAL_RISK_LIMITS,
  RiskParamsSchema,
} from "./risk.js";

describe("risk params", () => {
  it("DEFAULT_RISK_PARAMS is a valid RiskParams", () => {
    expect(() => RiskParamsSchema.parse(DEFAULT_RISK_PARAMS)).not.toThrow();
  });

  it("defaults never exceed the global ceilings (spec §5)", () => {
    expect(DEFAULT_RISK_PARAMS.maxRiskPerTradePct).toBeLessThanOrEqual(
      GLOBAL_RISK_LIMITS.maxRiskPerTradePct,
    );
    expect(DEFAULT_RISK_PARAMS.maxConcurrentPositions).toBeLessThanOrEqual(
      GLOBAL_RISK_LIMITS.maxConcurrentPositions,
    );
    expect(DEFAULT_RISK_PARAMS.maxPositionsPerStrategy).toBeLessThanOrEqual(
      GLOBAL_RISK_LIMITS.maxPositionsPerStrategy,
    );
    expect(DEFAULT_RISK_PARAMS.maxPositionsPerTicker).toBeLessThanOrEqual(
      GLOBAL_RISK_LIMITS.maxPositionsPerTicker,
    );
    expect(DEFAULT_RISK_PARAMS.maxTotalOpenRiskPct).toBeLessThanOrEqual(
      GLOBAL_RISK_LIMITS.maxTotalOpenRiskPct,
    );
    expect(DEFAULT_RISK_PARAMS.dailyLossLimitPct).toBeLessThanOrEqual(
      GLOBAL_RISK_LIMITS.dailyLossLimitPct,
    );
  });

  it("requires a stop and forbids averaging down by default", () => {
    expect(DEFAULT_RISK_PARAMS.requireStop).toBe(true);
    expect(DEFAULT_RISK_PARAMS.allowAveragingDown).toBe(false);
  });

  it("GLOBAL_RISK_LIMITS is frozen", () => {
    expect(Object.isFrozen(GLOBAL_RISK_LIMITS)).toBe(true);
  });

  it("rejects a non-positive per-trade risk", () => {
    expect(() =>
      RiskParamsSchema.parse({ ...DEFAULT_RISK_PARAMS, maxRiskPerTradePct: 0 }),
    ).toThrow();
  });

  it("applies boolean defaults for optional guardrails", () => {
    const p = RiskParamsSchema.parse({
      maxRiskPerTradePct: 1,
      maxConcurrentPositions: 3,
      maxPositionsPerStrategy: 1,
      maxPositionsPerTicker: 1,
      maxTotalOpenRiskPct: 4,
      dailyLossLimitPct: 2,
      requireStop: true,
      allowAveragingDown: false,
    });
    expect(p.noOvernightHolds).toBe(false);
    expect(p.definedRiskOptionsOnly).toBe(true);
  });
});
