import { describe, it, expect } from "vitest";
import type { Candle } from "@magpie/core";
import { ratioSeries, sma, ratioView } from "./indicators.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BASE = Date.parse("2024-01-01T00:00:00.000Z");

/** Build a weekly candle series from an array of closes (oldest→newest). */
function weekly(ticker: "QUAL" | "SPHB", closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    ticker,
    timeframe: "1w",
    ts: new Date(BASE + i * WEEK_MS),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  }));
}

describe("sma", () => {
  it("returns null during warm-up, then the trailing mean", () => {
    expect(sma([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
  });

  it("is numerically stable across a longer window", () => {
    const out = sma([10, 20, 30, 40, 50], 5);
    expect(out[4]).toBe(30);
    expect(out.slice(0, 4)).toEqual([null, null, null, null]);
  });

  it("rejects a non-positive or non-integer period", () => {
    expect(() => sma([1, 2, 3], 0)).toThrow();
    expect(() => sma([1, 2, 3], 1.5)).toThrow();
  });
});

describe("ratioSeries", () => {
  it("divides SPHB by QUAL on shared timestamps", () => {
    const sphb = weekly("SPHB", [100, 110, 120]);
    const qual = weekly("QUAL", [50, 55, 60]);
    expect(ratioSeries(sphb, qual)).toEqual([2, 2, 2]);
  });

  it("skips bars with no matching QUAL timestamp", () => {
    const sphb = weekly("SPHB", [100, 110, 120]);
    const qual = weekly("QUAL", [50, 55]); // one fewer bar
    expect(ratioSeries(sphb, qual)).toEqual([2, 2]);
  });
});

describe("ratioView", () => {
  it("is null until the SMA warms up", () => {
    const sphb = weekly("SPHB", [100, 110]);
    const qual = weekly("QUAL", [50, 55]);
    expect(ratioView(sphb, qual, 3)).toBeNull();
  });

  it("exposes current + previous ratio/sma once warm", () => {
    const sphb = weekly("SPHB", [100, 100, 100, 130]);
    const qual = weekly("QUAL", [100, 100, 100, 100]);
    const view = ratioView(sphb, qual, 3);
    expect(view).not.toBeNull();
    expect(view?.ratio).toBe(1.3);
    // sma of last 3 ratios [1,1,1.3] = 1.1
    expect(view?.sma).toBeCloseTo(1.1, 10);
    expect(view?.prevRatio).toBe(1);
    expect(view?.prevSma).toBe(1);
  });
});
