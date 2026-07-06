import { describe, it, expect } from "vitest";
import type { Candle, Ticker } from "@magpie/core";
import {
  detectSnapbackReclaim,
  DEFAULT_RECLAIM_PARAMS,
} from "./reclaim-detector.js";

const TICK: Ticker = "ABCD";
const OPEN = new Date("2024-06-03T13:30:00.000Z"); // US open, summer (13:30 UTC)

/** A 5-minute bar `idx` slots after the session open. */
function bar5m(
  idx: number,
  low: number,
  close: number,
  volume: number,
): Candle {
  const ts = new Date(OPEN.getTime() + idx * 5 * 60_000);
  return {
    ticker: TICK,
    timeframe: "5m",
    ts,
    open: close,
    high: close + 1,
    low,
    close,
    volume,
  };
}

/*
 * A clean snapback session: gap-down open, day low prints at 13:45 (bar 3),
 * then a series of higher lows reclaims the 92 opening-range low with a volume
 * surge on the signal bar. `now` is the last bar at 14:15 (45 min elapsed).
 */
function goodSession(): Candle[] {
  return [
    bar5m(0, 96, 97, 1_000), // opening range (< 13:45)
    bar5m(1, 94, 94, 1_000),
    bar5m(2, 92, 92.5, 1_000), // ORL = 92
    bar5m(3, 90, 91, 1_200), // day low = 90
    bar5m(4, 91, 92, 1_200), // higher low begins
    bar5m(5, 91.5, 93, 1_200),
    bar5m(6, 92, 93.5, 1_300),
    bar5m(7, 92.5, 94, 1_400),
    bar5m(8, 93, 94.5, 1_500),
    bar5m(9, 93.5, 95, 3_000), // reclaim close 95 > 92, volume surge
  ];
}

const NOW = new Date(OPEN.getTime() + 9 * 5 * 60_000); // 14:15, 45 min in

describe("detectSnapbackReclaim", () => {
  it("detects a higher-low ORL reclaim on rising volume", () => {
    const setup = detectSnapbackReclaim(goodSession(), NOW);
    expect(setup).not.toBeNull();
    expect(setup!.dayLow).toBe(90);
    expect(setup!.openingRangeLow).toBe(92);
    expect(setup!.higherLow).toBe(91);
    expect(setup!.reclaimPrice).toBe(95);
    expect(setup!.volumeRatio).toBeGreaterThan(1);
    expect(setup!.elapsedMinutes).toBe(45);
  });

  it("returns null before the wait window has elapsed", () => {
    const early = new Date(OPEN.getTime() + 30 * 60_000); // only 30 min in
    expect(detectSnapbackReclaim(goodSession(), early)).toBeNull();
  });

  it("returns null when price has not reclaimed the opening-range low", () => {
    const bars = goodSession();
    // Latest close drops back below the 92 ORL — no reclaim.
    bars[bars.length - 1] = bar5m(9, 91, 91.5, 3_000);
    expect(detectSnapbackReclaim(bars, NOW)).toBeNull();
  });

  it("returns null on a monotonic decline (no higher low, latest is the low)", () => {
    const bars: Candle[] = [
      bar5m(0, 100, 100, 1_000),
      bar5m(1, 98, 98, 1_000),
      bar5m(2, 96, 96, 1_000),
      bar5m(3, 94, 94, 1_200),
      bar5m(4, 92, 92, 1_200),
      bar5m(5, 90, 90, 1_300),
      bar5m(6, 88, 88, 1_400),
      bar5m(7, 86, 86, 1_500),
      bar5m(8, 84, 84, 1_600),
      bar5m(9, 82, 82, 3_000), // latest IS the day low → no higher low after it
    ];
    expect(detectSnapbackReclaim(bars, NOW)).toBeNull();
  });

  it("returns null when volume is not rising on the signal bar", () => {
    const bars = goodSession();
    bars[bars.length - 1] = bar5m(9, 93.5, 95, 500); // below the recent average
    expect(detectSnapbackReclaim(bars, NOW)).toBeNull();
  });

  it("returns null on an empty session", () => {
    expect(detectSnapbackReclaim([], NOW)).toBeNull();
  });

  it("honours a widened wait window via params", () => {
    // 45 min elapsed but a 60-min wait configured → not yet actionable.
    const params = { ...DEFAULT_RECLAIM_PARAMS, waitMinutes: 60 };
    expect(detectSnapbackReclaim(goodSession(), NOW, params)).toBeNull();
  });
});
