import { describe, expect, it } from "vitest";
import type { StrategyMeta } from "@magpie/core";
import { loadStrategies } from "./registry.js";
import { buildStrategyMetaById, AI_CROWDING_FILTER_ID } from "./metadata.js";
import { QualSphbStrategy } from "./qual-sphb/qual-sphb.strategy.js";

/** The full roster (spec §3.2): 7 executable plugins + the AI-crowding filter. */
const ROSTER_IDS = [
  "qual-sphb",
  "earnings-fade",
  "hype-momentum",
  "friday-monday-flow",
  "valuation-gravity",
  "snapback",
  "squeeze-scalp",
  AI_CROWDING_FILTER_ID,
];

function assertNonEmptyMeta(meta: StrategyMeta): void {
  expect(meta.summary.trim().length).toBeGreaterThan(0);
  expect(meta.mechanic.trigger.length).toBeGreaterThan(0);
  expect(meta.mechanic.trigger.every((t) => t.trim().length > 0)).toBe(true);
  expect(meta.mechanic.exitPlan.length).toBeGreaterThan(0);
  expect(meta.mechanic.exitPlan.every((e) => e.trim().length > 0)).toBe(true);
  expect(meta.mechanic.llmRole.trim().length).toBeGreaterThan(0);
  expect(meta.mechanic.dataNeeds.trim().length).toBeGreaterThan(0);
}

describe("strategy metadata", () => {
  it("every registered strategy carries non-empty metadata", () => {
    const strategies = loadStrategies();
    expect(strategies.length).toBeGreaterThan(0);
    for (const strategy of strategies) {
      assertNonEmptyMeta(strategy.meta);
    }
  });

  it("the id→metadata map covers all eight roster strategies", () => {
    const map = buildStrategyMetaById();
    expect(Object.keys(map).sort()).toEqual([...ROSTER_IDS].sort());
    for (const id of ROSTER_IDS) {
      assertNonEmptyMeta(map[id]!);
    }
  });

  it("marks exactly the live-feed strategies as dataReady", () => {
    // qual-sphb (weekly price candles) + ai-crowding-filter (Claude web search)
    // were the original two; friday-monday-flow was wired to run on the live
    // daily-candle feed against a fixed watchlist, so it joins them.
    const map = buildStrategyMetaById();
    const ready = Object.entries(map)
      .filter(([, meta]) => meta.dataReady)
      .map(([id]) => id)
      .sort();
    expect(ready).toEqual([
      "ai-crowding-filter",
      "friday-monday-flow",
      "qual-sphb",
    ]);
  });

  it("renders qual-sphb thresholds from config, not hardcoded prose", () => {
    // The displayed numbers must track the coded params: changing the band and
    // SMA window must change the text (spec §U2 AC).
    const def = new QualSphbStrategy().meta.mechanic.trigger.join(" ");
    expect(def).toContain("5%");
    expect(def).toContain("20-week");

    const tuned = new QualSphbStrategy({
      entryBand: 0.09,
      smaWeeks: 30,
    }).meta.mechanic.trigger.join(" ");
    expect(tuned).toContain("9%");
    expect(tuned).toContain("30-week");
    expect(tuned).not.toContain("5%");
  });
});
