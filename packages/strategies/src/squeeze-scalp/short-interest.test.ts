import { describe, it, expect } from "vitest";
import {
  StaticShortInterestProvider,
  type ShortInterestDatum,
} from "./short-interest.js";

const ASOF = new Date("2024-06-03T12:00:00.000Z");

function datum(ticker: string, si: number): ShortInterestDatum {
  return { ticker, shortInterestPctFloat: si, asOf: "2024-06-02" };
}

describe("StaticShortInterestProvider", () => {
  const roster: ShortInterestDatum[] = [
    datum("HIGH", 0.35), // qualifies
    datum("EDGE", 0.2), // exactly at the 20% threshold → qualifies
    datum("LOW", 0.12), // below threshold → filtered out
  ];

  it("keeps only names at or above the short-interest threshold", async () => {
    const out = await new StaticShortInterestProvider(roster).highShortInterest(
      ASOF,
    );
    expect(out.map((d) => d.ticker)).toEqual(["EDGE", "HIGH"]);
  });

  it("sorts by ticker for deterministic replay", async () => {
    const out = await new StaticShortInterestProvider([
      datum("ZZZ", 0.3),
      datum("AAA", 0.3),
    ]).highShortInterest(ASOF);
    expect(out.map((d) => d.ticker)).toEqual(["AAA", "ZZZ"]);
  });

  it("is empty by default (no nightly ingest wired in)", async () => {
    expect(
      await new StaticShortInterestProvider().highShortInterest(ASOF),
    ).toEqual([]);
  });

  it("honours an overridden threshold", async () => {
    const out = await new StaticShortInterestProvider(roster, {
      minShortInterestPctFloat: 0.3,
    }).highShortInterest(ASOF);
    expect(out.map((d) => d.ticker)).toEqual(["HIGH"]);
  });
});
