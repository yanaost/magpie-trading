import { describe, it, expect } from "vitest";
import type { Candle } from "@magpie/core";
import {
  detectHypeSpike,
  hypeExitDecision,
  closeMA,
  type HypeView,
} from "./spike-detector.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = Date.parse("2024-05-01T00:00:00.000Z");

function bar(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
  vol: number,
): Candle {
  return {
    ticker: "HYPE",
    timeframe: "1d",
    ts: new Date(BASE + i * DAY_MS),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: vol,
  };
}

/** 21 flat base bars (price ~100, volume 1M), then push a custom last bar. */
function baseSeries(): Candle[] {
  return Array.from({ length: 21 }, (_, i) =>
    bar(i, 100, 101, 99, 100, 1_000_000),
  );
}

describe("detectHypeSpike", () => {
  it("fires on a fresh up-day volume-spike breakout above resistance", () => {
    const candles = baseSeries();
    // Resistance = 101 (max prior high). Break out to 108 on 3× volume, up day.
    candles.push(bar(21, 101, 109, 100, 108, 3_000_000));
    const res = detectHypeSpike(candles);
    expect(res).not.toBeNull();
    expect(res!.spikeIndex).toBe(21);
    expect(res!.spikeClose).toBe(108);
    expect(res!.resistance).toBe(101);
    expect(res!.volMult).toBeCloseTo(3, 5);
  });

  it("does not fire without a volume spike", () => {
    const candles = baseSeries();
    candles.push(bar(21, 101, 109, 100, 108, 1_200_000)); // only 1.2× avg
    expect(detectHypeSpike(candles)).toBeNull();
  });

  it("does not fire when price fails to clear resistance", () => {
    const candles = baseSeries();
    candles.push(bar(21, 100, 100.9, 99, 100.5, 3_000_000)); // 100.5 < 101
    expect(detectHypeSpike(candles)).toBeNull();
  });

  it("does not fire on a red day even with spike volume", () => {
    const candles = baseSeries();
    candles.push(bar(21, 108, 109, 101, 102, 3_000_000)); // closes below open
    expect(detectHypeSpike(candles)).toBeNull();
  });

  it("returns null without enough history", () => {
    const candles = baseSeries().slice(0, 10);
    candles.push(bar(10, 101, 109, 100, 108, 3_000_000));
    expect(detectHypeSpike(candles)).toBeNull();
  });
});

// A healthy still-running view: strong green day, new high, above the exit MA,
// no earnings pending. Every rule below toggles exactly one field off this base.
const HEALTHY: HypeView = {
  asOf: new Date("2024-05-25T00:00:00.000Z"),
  lastOpen: 110,
  lastClose: 118,
  lastHigh: 119,
  lastVolume: 2_000_000,
  priorHigh: 112,
  avgVolume: 1_000_000,
  maExit: 108,
  nextEarningsDate: null,
};

describe("hypeExitDecision", () => {
  it("holds a healthy, still-advancing position", () => {
    expect(hypeExitDecision(HEALTHY)).toBeNull();
  });

  it("HARD exits before an upcoming earnings date (inside the block window)", () => {
    const view: HypeView = {
      ...HEALTHY,
      nextEarningsDate: "2024-05-27", // 2 days out ≤ 3-day block
    };
    const action = hypeExitDecision(view);
    expect(action?.kind).toBe("close");
    expect(action?.reason).toMatch(/earnings/i);
    expect(action?.reason).toMatch(/hard rule/i);
  });

  it("earnings-block outranks an otherwise-healthy hold and beats other rules", () => {
    // Red heavy-volume day AND earnings due → earnings reason wins (priority 1).
    const view: HypeView = {
      ...HEALTHY,
      lastOpen: 118,
      lastClose: 110, // red
      lastVolume: 3_000_000, // heavy
      nextEarningsDate: "2024-05-26",
    };
    expect(hypeExitDecision(view)?.reason).toMatch(/earnings/i);
  });

  it("does NOT block on an earnings date beyond the window", () => {
    const view: HypeView = { ...HEALTHY, nextEarningsDate: "2024-06-10" };
    expect(hypeExitDecision(view)).toBeNull();
  });

  it("does NOT block on an earnings date already in the past", () => {
    const view: HypeView = { ...HEALTHY, nextEarningsDate: "2024-05-20" };
    expect(hypeExitDecision(view)).toBeNull();
  });

  it("exits on the first heavy-volume red day (distribution)", () => {
    const view: HypeView = {
      ...HEALTHY,
      lastOpen: 118,
      lastClose: 112, // red
      lastVolume: 2_000_000, // 2× avg ≥ 1.5× stall threshold
    };
    const action = hypeExitDecision(view);
    expect(action?.kind).toBe("close");
    expect(action?.reason).toMatch(/heavy-volume red/i);
  });

  it("does not treat a light-volume red day as distribution", () => {
    const view: HypeView = {
      ...HEALTHY,
      lastOpen: 118,
      lastClose: 116, // red but shallow
      lastHigh: 120, // still a higher high, above maExit
      lastVolume: 900_000, // below the 1.5× stall threshold
    };
    expect(hypeExitDecision(view)).toBeNull();
  });

  it("exits on a lower high that rolls over (momentum stall)", () => {
    const view: HypeView = {
      ...HEALTHY,
      lastOpen: 116,
      lastClose: 114, // red
      lastHigh: 111, // below priorHigh 112 → lower high
      lastVolume: 1_000_000, // not heavy
    };
    const action = hypeExitDecision(view);
    expect(action?.kind).toBe("close");
    expect(action?.reason).toMatch(/lower high/i);
  });

  it("exits the remainder on a close below the exit MA", () => {
    const view: HypeView = {
      ...HEALTHY,
      lastOpen: 106,
      lastClose: 107, // green day, but below maExit 108
      lastHigh: 113, // higher high — only the MA rule fires
      lastVolume: 900_000, // light — no distribution trigger
    };
    const action = hypeExitDecision(view);
    expect(action?.kind).toBe("close");
    expect(action?.reason).toMatch(/below the 5-day MA/i);
  });
});

describe("closeMA", () => {
  it("averages the last window of closes", () => {
    const candles = [
      bar(0, 0, 0, 0, 10, 1),
      bar(1, 0, 0, 0, 20, 1),
      bar(2, 0, 0, 0, 30, 1),
    ];
    expect(closeMA(candles, 2)).toBe(25); // (20+30)/2
    expect(closeMA(candles, 3)).toBe(20);
    expect(closeMA(candles, 5)).toBeNull();
  });
});
