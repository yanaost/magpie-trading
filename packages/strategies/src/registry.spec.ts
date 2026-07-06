/**
 * Strategy registry tests (T2.3 AC: "adding a dummy strategy makes it appear
 * with zero code changes elsewhere"). We prove the loader is a pure fan-out over
 * its factory list: a newly-registered dummy strategy flows through unchanged,
 * and duplicate ids are caught early.
 */
import { describe, expect, it } from "vitest";
import type { Strategy } from "@magpie/core";
import {
  loadStrategies,
  STRATEGY_FACTORIES,
  type StrategyFactory,
} from "./registry.js";

/** A minimal stand-in strategy — only the identity fields the loader reads. */
function dummyStrategy(id: string): Strategy {
  return {
    id,
    name: `Dummy ${id}`,
    timeframe: "swing",
    defaultMode: "WATCH",
  } as unknown as Strategy;
}

describe("loadStrategies", () => {
  it("instantiates every shipped factory with unique ids", () => {
    const strategies = loadStrategies();
    expect(strategies.length).toBe(STRATEGY_FACTORIES.length);
    const ids = strategies.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("qual-sphb");
  });

  it("surfaces a newly-registered dummy strategy with no loader changes", () => {
    const withDummy: StrategyFactory[] = [
      ...STRATEGY_FACTORIES,
      () => dummyStrategy("dummy-alpha"),
    ];
    const ids = loadStrategies(withDummy).map((s) => s.id);
    // The dummy appears purely by being registered — the loader is untouched.
    expect(ids).toContain("dummy-alpha");
    expect(ids.length).toBe(STRATEGY_FACTORIES.length + 1);
  });

  it("rejects a registry with duplicate ids", () => {
    const dupes: StrategyFactory[] = [
      () => dummyStrategy("clash"),
      () => dummyStrategy("clash"),
    ];
    expect(() => loadStrategies(dupes)).toThrow(/duplicate strategy id/);
  });
});
