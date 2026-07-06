import { describe, it, expect } from "vitest";
import type { Candle } from "@magpie/core";
import {
  detectPostEarningsStall,
  DEFAULT_STALL_PARAMS,
} from "./stall-detector.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = Date.parse("2024-03-01T00:00:00.000Z");

/** Build a daily OHLC bar `i` days after BASE. */
function bar(i: number, o: number, h: number, l: number, c: number): Candle {
  return {
    ticker: "TEST",
    timeframe: "1d",
    ts: new Date(BASE + i * DAY_MS),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1_000_000,
  };
}

/** ISO date of day `i`. */
function day(i: number): string {
  return new Date(BASE + i * DAY_MS).toISOString().slice(0, 10);
}

describe("detectPostEarningsStall", () => {
  it("detects a failed-bounce stall below the post-earnings high", () => {
    // Day 0: pre-report close 100. Day 1 (report): gaps down, closes 85 (−15%),
    // high 92. Day 2: dead-cat bounce, pokes to 90 (< 92) then closes red at 86.
    const candles = [
      bar(0, 100, 101, 99, 100), // prior session
      bar(1, 93, 92, 84, 85), // reaction: −15%, postEarningsHigh 92
      bar(2, 87, 90, 85, 86), // bounce pokes to 90, closes red 86 → stall
      bar(3, 86, 87, 80, 81), // continuation down
    ];
    const res = detectPostEarningsStall(candles, day(1));
    expect(res).not.toBeNull();
    expect(res!.reactionIndex).toBe(1);
    expect(res!.stallIndex).toBe(2);
    expect(res!.postEarningsHigh).toBe(92);
    expect(res!.reactionMovePct).toBeCloseTo(-0.15, 5);
    expect(res!.reactionLow).toBe(84);
    expect(res!.stallClose).toBe(86);
  });

  it("detects a stall on day 3 when day 2 keeps bouncing", () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 93, 92, 84, 85), // reaction −15%
      bar(2, 86, 89, 85, 88), // day 2: green bounce (no rollover)
      bar(3, 88, 91, 87, 87.5), // day 3: pokes to 91 (< 92), closes red → stall
    ];
    const res = detectPostEarningsStall(candles, day(1));
    expect(res).not.toBeNull();
    expect(res!.stallIndex).toBe(3);
  });

  it("returns null when the reaction was not a real miss (small move)", () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 101, 98, 98), // only −2%, above the −5% threshold
      bar(2, 98, 100, 97, 97.5), // red bounce, but no qualifying reaction
    ];
    expect(detectPostEarningsStall(candles, day(1))).toBeNull();
  });

  it("returns null when the bounce reclaims the post-earnings high (no stall)", () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 93, 92, 84, 85), // reaction −15%, high 92
      bar(2, 86, 95, 85, 94), // reclaims above 92 and closes green → thesis fails
    ];
    expect(detectPostEarningsStall(candles, day(1))).toBeNull();
  });

  it("returns null when price keeps falling with no bounce attempt", () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 93, 92, 84, 85), // reaction −15%
      bar(2, 84, 84.5, 80, 81), // straight down, high never recovers above close 85
      bar(3, 81, 81.5, 78, 79),
    ];
    expect(detectPostEarningsStall(candles, day(1))).toBeNull();
  });

  it("returns null without enough history around the report", () => {
    // Reaction is the first bar → no prior close to measure the move.
    const candles = [bar(1, 93, 92, 84, 85), bar(2, 86, 90, 85, 86)];
    expect(detectPostEarningsStall(candles, day(1))).toBeNull();
  });

  it("honours a widened belowHighMargin (bounce must stall further under the high)", () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 93, 92, 84, 85), // high 92
      bar(2, 87, 91, 85, 86), // pokes to 91 — within 2% of 92, closes red
    ];
    // Default margin 0 → 91 < 92 qualifies.
    expect(detectPostEarningsStall(candles, day(1))).not.toBeNull();
    // Require the bounce to stall ≥5% under the high → ceiling 87.4, 91 fails.
    expect(
      detectPostEarningsStall(candles, day(1), {
        ...DEFAULT_STALL_PARAMS,
        belowHighMargin: 0.05,
      }),
    ).toBeNull();
  });
});
