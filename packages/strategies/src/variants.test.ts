import { describe, expect, it } from "vitest";
import {
  buildVariantStrategy,
  DEFAULT_SNAPBACK_VARIANTS,
  snapbackWaitVariants,
  supportsVariants,
} from "./variants.js";

describe("snapbackWaitVariants", () => {
  it("builds one spec per wait time with stable ids and labels", () => {
    const variants = snapbackWaitVariants([30, 60]);
    expect(variants).toEqual([
      {
        instanceId: "snapback:wait30",
        strategyId: "snapback",
        label: "30-min wait",
        params: { waitMinutes: 30 },
      },
      {
        instanceId: "snapback:wait60",
        strategyId: "snapback",
        label: "60-min wait",
        params: { waitMinutes: 60 },
      },
    ]);
  });

  it("ships 30 vs 60 as the default comparison", () => {
    expect(DEFAULT_SNAPBACK_VARIANTS.map((v) => v.params)).toEqual([
      { waitMinutes: 30 },
      { waitMinutes: 60 },
    ]);
  });
});

describe("buildVariantStrategy", () => {
  it("constructs a snapback instance from a variant spec", () => {
    const [v30] = snapbackWaitVariants([30]);
    const strategy = buildVariantStrategy(v30!);
    expect(strategy.id).toBe("snapback");
    expect(strategy.timeframe).toBe("intraday");
  });

  it("throws for a strategy with no variant builder", () => {
    expect(() =>
      buildVariantStrategy({
        instanceId: "x:1",
        strategyId: "earnings-fade",
        label: "x",
        params: {},
      }),
    ).toThrow(/no variant builder/);
  });
});

describe("supportsVariants", () => {
  it("reports snapback as variant-capable and others not", () => {
    expect(supportsVariants("snapback")).toBe(true);
    expect(supportsVariants("earnings-fade")).toBe(false);
  });
});
