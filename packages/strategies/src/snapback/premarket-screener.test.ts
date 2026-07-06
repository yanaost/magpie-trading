import { describe, it, expect } from "vitest";
import {
  StaticPremarketScreener,
  gapDownPct,
  type PremarketGapper,
} from "./premarket-screener.js";

const ASOF = new Date("2024-06-03T12:00:00.000Z");

function gapper(
  ticker: string,
  prevClose: number,
  premarketPrice: number,
  marketCap: number,
): PremarketGapper {
  return { ticker, prevClose, premarketPrice, marketCap };
}

describe("gapDownPct", () => {
  it("computes the down-gap as a positive fraction of the prior close", () => {
    expect(gapDownPct(gapper("A", 100, 88, 1e9))).toBeCloseTo(0.12, 10);
  });

  it("is zero (guarded) when the prior close is non-positive", () => {
    expect(gapDownPct(gapper("A", 0, 0, 1e9))).toBe(0);
  });
});

describe("StaticPremarketScreener", () => {
  const candidates: PremarketGapper[] = [
    gapper("DOWN12", 100, 88, 1_000_000_000), // in band, −12% → qualifies
    gapper("SMALLGAP", 100, 95, 1_000_000_000), // only −5% → filtered out
    gapper("TOOBIG", 100, 85, 5_000_000_000), // −15% but $5B cap → filtered out
    gapper("TOOSMALL", 100, 85, 100_000_000), // −15% but $100M cap → filtered out
    gapper("EDGE10", 100, 90, 2_000_000_000), // exactly −10% at $2B → qualifies
  ];

  it("keeps only names in the small-cap band that gapped past the threshold", async () => {
    const screener = new StaticPremarketScreener(candidates);
    const out = await screener.gappers(ASOF);
    expect(out.map((g) => g.ticker)).toEqual(["DOWN12", "EDGE10"]);
  });

  it("returns candidates sorted by ticker for deterministic replay", async () => {
    const screener = new StaticPremarketScreener([
      gapper("ZZZ", 100, 85, 1e9),
      gapper("AAA", 100, 85, 1e9),
    ]);
    const out = await screener.gappers(ASOF);
    expect(out.map((g) => g.ticker)).toEqual(["AAA", "ZZZ"]);
  });

  it("is empty by default (no pre-market feed wired in)", async () => {
    expect(await new StaticPremarketScreener().gappers(ASOF)).toEqual([]);
  });

  it("honours overridden band params", async () => {
    const screener = new StaticPremarketScreener(candidates, {
      maxMarketCap: 10_000_000_000,
    });
    const out = await screener.gappers(ASOF);
    expect(out.map((g) => g.ticker)).toContain("TOOBIG");
  });
});
