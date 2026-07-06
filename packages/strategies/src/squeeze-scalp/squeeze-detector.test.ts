import { describe, it, expect } from "vitest";
import type { Candle, Ticker } from "@magpie/core";
import {
  detectSqueezeBreakout,
  intradayGainPct,
  planScaleOut,
  DEFAULT_SQUEEZE_PARAMS,
} from "./squeeze-detector.js";

const TICK: Ticker = "SQZ";
const OPEN = new Date("2024-06-03T13:30:00.000Z");

function bar5m(
  idx: number,
  high: number,
  close: number,
  volume: number,
): Candle {
  const ts = new Date(OPEN.getTime() + idx * 5 * 60_000);
  return {
    ticker: TICK,
    timeframe: "5m",
    ts,
    open: idx === 0 ? close : close - 0.5,
    high,
    low: close - 1,
    close,
    volume,
  };
}

/*
 * A quiet consolidation building resistance near 20.5, then a volume breakout on
 * the final bar to 21.2. Session opens at 20.0 → ~6% day gain, well under the
 * chase guard.
 */
function breakoutSession(): Candle[] {
  return [
    bar5m(0, 20.3, 20.0, 1_000),
    bar5m(1, 20.4, 20.1, 1_000),
    bar5m(2, 20.5, 20.2, 1_000),
    bar5m(3, 20.4, 20.1, 1_000),
    bar5m(4, 20.5, 20.3, 1_000),
    bar5m(5, 20.4, 20.2, 1_000),
    bar5m(6, 21.4, 21.2, 3_000), // break above 20.5 resistance on 3× volume
  ];
}

describe("intradayGainPct", () => {
  it("measures the day's move from the session open", () => {
    expect(intradayGainPct(breakoutSession())).toBeCloseTo(0.06, 4);
  });

  it("is zero on an empty session", () => {
    expect(intradayGainPct([])).toBe(0);
  });
});

describe("detectSqueezeBreakout", () => {
  it("detects a resistance break confirmed by volume", () => {
    const setup = detectSqueezeBreakout(breakoutSession());
    expect(setup).not.toBeNull();
    expect(setup!.breakoutPrice).toBe(21.2);
    expect(setup!.resistance).toBe(20.5);
    expect(setup!.volumeRatio).toBeGreaterThanOrEqual(1.5);
  });

  it("chase guard vetoes an already-extended name (+30% on the day)", () => {
    const bars = breakoutSession();
    // Same break, but the session opened far lower → up ~55% on the day.
    bars[0] = { ...bars[0]!, open: 13.7 };
    expect(detectSqueezeBreakout(bars)).toBeNull();
  });

  it("returns null when price has not cleared resistance", () => {
    const bars = breakoutSession();
    bars[bars.length - 1] = bar5m(6, 20.5, 20.4, 3_000); // stays under 20.5
    expect(detectSqueezeBreakout(bars)).toBeNull();
  });

  it("returns null when the break lacks volume", () => {
    const bars = breakoutSession();
    bars[bars.length - 1] = bar5m(6, 21.4, 21.2, 900); // below average volume
    expect(detectSqueezeBreakout(bars)).toBeNull();
  });

  it("returns null with too few bars to define resistance", () => {
    expect(detectSqueezeBreakout([bar5m(0, 20.3, 20.0, 1_000)])).toBeNull();
  });

  it("honours a stricter chase guard via params", () => {
    const bars = breakoutSession(); // ~6% day gain
    const params = { ...DEFAULT_SQUEEZE_PARAMS, chaseGuardGainPct: 0.05 };
    expect(detectSqueezeBreakout(bars, params)).toBeNull();
  });
});

describe("planScaleOut", () => {
  const ENTRY = 20;
  const QTY = 100;

  it("holds below the first tranche", () => {
    expect(planScaleOut(ENTRY, QTY, QTY, 20.8)).toEqual({ action: "hold" });
  });

  it("banks half at the first tranche while the position is whole", () => {
    // +5% at price 21.
    expect(planScaleOut(ENTRY, QTY, QTY, 21)).toEqual({
      action: "scale-out",
      qty: 50,
    });
  });

  it("does not re-fire the first tranche once already scaled", () => {
    // Remaining 50 < entry 100 → the first rung is spent; still under runner.
    expect(planScaleOut(ENTRY, QTY, 50, 21)).toEqual({ action: "hold" });
  });

  it("closes the runner at the far target", () => {
    // +10% at price 22, whatever remains.
    expect(planScaleOut(ENTRY, QTY, 50, 22)).toEqual({ action: "close" });
  });

  it("holds on a non-position (zero remaining)", () => {
    expect(planScaleOut(ENTRY, QTY, 0, 25)).toEqual({ action: "hold" });
  });
});
