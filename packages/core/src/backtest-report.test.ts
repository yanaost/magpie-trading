import { describe, expect, it } from "vitest";
import type { ClosedTrade } from "./performance.js";
import type { SimClosedTrade } from "./simulator.js";
import {
  buildBacktestReport,
  emptyVetoStats,
  simTradesToClosedTrades,
  tallyOutcomes,
} from "./backtest-report.js";

const T = (iso: string) => new Date(iso);

function trade(over: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    realizedPnl: 100,
    qty: 100,
    entryPrice: 100,
    stopPrice: 95,
    closedAt: T("2026-03-02T15:00:00.000Z"),
    ...over,
  };
}

describe("tallyOutcomes — per-rule veto stats", () => {
  it("buckets each SignalOutcome kind and totals signals", () => {
    const stats = tallyOutcomes([
      { kind: "executed" },
      { kind: "executed" },
      { kind: "proposed" },
      { kind: "watched" },
      { kind: "vetoed" },
      { kind: "crowded" },
      { kind: "risk-rejected" },
      { kind: "auto-capped" },
    ]);
    expect(stats).toEqual({
      signals: 8,
      executed: 2,
      proposed: 1,
      watched: 1,
      vetoedByLlm: 1,
      vetoedByCrowding: 1,
      riskRejected: 1,
      autoCapped: 1,
    });
  });

  it("returns zero stats for no outcomes", () => {
    expect(tallyOutcomes([])).toEqual(emptyVetoStats());
  });

  it("counts an unknown kind toward signals but no bucket", () => {
    const stats = tallyOutcomes([{ kind: "future-kind" }]);
    expect(stats.signals).toBe(1);
    expect(stats.executed).toBe(0);
  });
});

describe("simTradesToClosedTrades", () => {
  const base: Omit<SimClosedTrade, "realizedPnl" | "entryPrice"> = {
    strategyId: "snapback",
    bracketId: "br-1",
    ticker: "SNAP",
    side: "long",
    qty: 100,
    stopPrice: 95,
    closedAt: T("2026-03-02T15:00:00.000Z"),
  };

  it("maps filled trades and preserves realizedPnl + stop for R", () => {
    const mapped = simTradesToClosedTrades([
      { ...base, entryPrice: 100, realizedPnl: -500 },
    ]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      realizedPnl: -500,
      qty: 100,
      entryPrice: 100,
      stopPrice: 95,
    });
  });

  it("drops trades that never filled (no entry price)", () => {
    const mapped = simTradesToClosedTrades([
      { ...base, entryPrice: undefined, realizedPnl: 0 },
      { ...base, entryPrice: 100, realizedPnl: 200 },
    ]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.realizedPnl).toBe(200);
  });
});

describe("buildBacktestReport", () => {
  it("combines performance, veto stats, and the stubbing caveat", () => {
    const report = buildBacktestReport({
      trades: [
        trade({ realizedPnl: 200, closedAt: T("2026-03-02T15:00:00.000Z") }),
        trade({ realizedPnl: -100, closedAt: T("2026-03-03T15:00:00.000Z") }),
      ],
      outcomes: [
        { kind: "executed" },
        { kind: "executed" },
        { kind: "vetoed" },
      ],
      analyses: 3,
      stubbed: 1,
    });

    expect(report.performance.trades).toBe(2);
    expect(report.performance.wins).toBe(1);
    expect(report.performance.losses).toBe(1);
    expect(report.performance.totalPnl).toBe(100);
    expect(report.vetoStats.executed).toBe(2);
    expect(report.vetoStats.vetoedByLlm).toBe(1);
    expect(report.stubbing).toEqual({
      analyses: 3,
      stubbed: 1,
      stubbedFraction: 1 / 3,
    });
    expect(report.replayStubbed).toBe(true);
  });

  it("flags replayStubbed=false when nothing was stubbed", () => {
    const report = buildBacktestReport({
      trades: [],
      outcomes: [],
      analyses: 5,
      stubbed: 0,
    });
    expect(report.replayStubbed).toBe(false);
    expect(report.stubbing.stubbedFraction).toBe(0);
    expect(report.performance.trades).toBe(0);
  });

  it("treats zero analyses as a zero stubbed fraction (no divide-by-zero)", () => {
    const report = buildBacktestReport({
      trades: [],
      outcomes: [],
      analyses: 0,
      stubbed: 0,
    });
    expect(report.stubbing.stubbedFraction).toBe(0);
  });
});
