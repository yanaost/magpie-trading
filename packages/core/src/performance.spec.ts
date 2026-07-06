/**
 * Performance math unit tests (T2.3). Pure reductions — win rate, avg R, max
 * drawdown, and the equity curve — over hand-built closed-trade sets so the
 * numbers are checkable by inspection.
 */
import { describe, expect, it } from "vitest";
import {
  computePerformance,
  emptyPerformance,
  rMultiple,
  type ClosedTrade,
} from "./performance.js";

function trade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    realizedPnl: 100,
    qty: 100,
    entryPrice: 100,
    stopPrice: 99,
    closedAt: new Date("2026-07-05T14:00:00.000Z"),
    ...overrides,
  };
}

describe("rMultiple", () => {
  it("expresses PnL in units of entry risk", () => {
    // risk = 100 shares * |100 - 99| = 100; pnl 250 => +2.5R.
    expect(rMultiple(trade({ realizedPnl: 250 }))).toBe(2.5);
    // a full-risk loss is exactly -1R.
    expect(rMultiple(trade({ realizedPnl: -100 }))).toBe(-1);
  });

  it("is null without a stop or with zero risk", () => {
    expect(rMultiple(trade({ stopPrice: undefined }))).toBeNull();
    expect(rMultiple(trade({ entryPrice: 100, stopPrice: 100 }))).toBeNull();
  });
});

describe("computePerformance", () => {
  it("returns the empty stats for no trades", () => {
    expect(computePerformance([])).toEqual(emptyPerformance());
  });

  it("counts wins/losses and computes win rate + avg R", () => {
    const stats = computePerformance([
      trade({ realizedPnl: 200 }), // +2R
      trade({ realizedPnl: -100 }), // -1R
      trade({ realizedPnl: 300 }), // +3R
      trade({ realizedPnl: 0 }), // scratch — neither win nor loss
    ]);
    expect(stats.trades).toBe(4);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBe(0.5);
    // avg of +2, -1, +3, 0 (scratch still has a stop → counted) = 1.
    expect(stats.avgR).toBe(1);
    expect(stats.totalPnl).toBe(400);
  });

  it("excludes stop-less trades from avg R but keeps them in win rate", () => {
    const stats = computePerformance([
      trade({ realizedPnl: 200 }), // +2R
      trade({ realizedPnl: 50, stopPrice: undefined }), // win, no R
    ]);
    expect(stats.winRate).toBe(1);
    expect(stats.avgR).toBe(2); // only the first trade contributes
  });

  it("builds the equity curve in close order and finds max drawdown", () => {
    const stats = computePerformance([
      trade({
        realizedPnl: 500,
        closedAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
      trade({
        realizedPnl: -300,
        closedAt: new Date("2026-07-02T00:00:00.000Z"),
      }),
      trade({
        realizedPnl: -100,
        closedAt: new Date("2026-07-03T00:00:00.000Z"),
      }),
      trade({
        realizedPnl: 400,
        closedAt: new Date("2026-07-04T00:00:00.000Z"),
      }),
    ]);
    // cumulative: 500, 200, 100, 500. peak 500, trough 100 => drawdown 400.
    expect(stats.equityCurve.map((p) => p.equity)).toEqual([
      500, 200, 100, 500,
    ]);
    expect(stats.maxDrawdown).toBe(400);
  });

  it("sorts out-of-order trades by close time before curving", () => {
    const stats = computePerformance([
      trade({
        realizedPnl: -100,
        closedAt: new Date("2026-07-02T00:00:00.000Z"),
      }),
      trade({
        realizedPnl: 500,
        closedAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ]);
    expect(stats.equityCurve.map((p) => p.equity)).toEqual([500, 400]);
    expect(stats.maxDrawdown).toBe(100);
  });
});
