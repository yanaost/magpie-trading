/**
 * DashboardService unit tests (T1.9). The Simulator and DB client are faked —
 * no network — so we verify the distance-to-stop / open-risk math, the
 * portfolio rollup, and that a mode/target change updates the row and writes an
 * audit record.
 */
import { describe, expect, it, vi } from "vitest";
import type { Position, Simulator } from "@magpie/core";
import type { DbClient } from "../infra/infra.module.js";
import { DashboardService } from "./dashboard.service.js";

const OPENED = new Date("2026-07-05T14:00:00.000Z");

function position(overrides: Partial<Position> = {}): Position {
  return {
    strategyId: "qual-sphb",
    target: "SIM",
    ticker: "QUAL",
    side: "long",
    status: "open",
    qty: 100,
    avgEntryPrice: 100,
    stopPrice: 92,
    realizedPnl: 0,
    unrealizedPnl: 0,
    openedAt: OPENED,
    ...overrides,
  };
}

function fakeSimulator(positions: Position[]): Simulator {
  return {
    getPositions: vi.fn(async () => positions),
  } as unknown as Simulator;
}

describe("DashboardService.openPositions", () => {
  it("computes distance-to-stop and open risk for a long", async () => {
    const svc = new DashboardService(
      {} as DbClient,
      fakeSimulator([position()]),
    );
    const [p] = await svc.openPositions();
    // (100 - 92) / 100 = 8%; risk = 100 * |100 - 92| = 800.
    expect(p).toMatchObject({
      ticker: "QUAL",
      side: "long",
      distanceToStopPct: 8,
      openRiskUsd: 800,
    });
    expect(p!.openedAt).toBe(OPENED.toISOString());
  });

  it("mirrors the distance for a short", async () => {
    const svc = new DashboardService(
      {} as DbClient,
      fakeSimulator([
        position({ side: "short", avgEntryPrice: 100, stopPrice: 108 }),
      ]),
    );
    const [p] = await svc.openPositions();
    // short stop is above entry: (108 - 100) / 100 = 8%.
    expect(p!.distanceToStopPct).toBe(8);
    expect(p!.openRiskUsd).toBe(800);
  });

  it("tolerates a missing stop", async () => {
    const svc = new DashboardService(
      {} as DbClient,
      fakeSimulator([position({ stopPrice: undefined })]),
    );
    const [p] = await svc.openPositions();
    expect(p!.stopPrice).toBeNull();
    expect(p!.distanceToStopPct).toBeNull();
    expect(p!.openRiskUsd).toBe(0);
  });
});

describe("DashboardService.portfolio", () => {
  it("rolls up open positions, total risk, and distinct tickers", async () => {
    const svc = new DashboardService(
      {} as DbClient,
      fakeSimulator([
        position(),
        position({ ticker: "SPHB", avgEntryPrice: 50, stopPrice: 46 }),
      ]),
    );
    const roll = await svc.portfolio();
    expect(roll.openPositions).toBe(2);
    // 800 + 100 * |50 - 46| = 800 + 400.
    expect(roll.openRiskUsd).toBe(1200);
    expect(roll.tickers.sort()).toEqual(["QUAL", "SPHB"]);
  });
});

describe("DashboardService.performance", () => {
  it("computes per-target stats from closed positions", async () => {
    const rows = [
      {
        target: "SIM",
        realized_pnl: "200",
        qty: "100",
        avg_entry_price: "100",
        stop_price: "99",
        closed_at: new Date("2026-07-01T00:00:00.000Z"),
      },
      {
        target: "SIM",
        realized_pnl: "-100",
        qty: "100",
        avg_entry_price: "100",
        stop_price: "99",
        closed_at: new Date("2026-07-02T00:00:00.000Z"),
      },
      {
        target: "PAPER",
        realized_pnl: "50",
        qty: "10",
        avg_entry_price: "20",
        stop_price: null,
        closed_at: new Date("2026-07-03T00:00:00.000Z"),
      },
    ];
    const dbClient = {
      sql: vi.fn(async () => rows),
    } as unknown as DbClient;
    const svc = new DashboardService(dbClient, fakeSimulator([]));

    const perf = await svc.performance("qual-sphb");
    expect(perf.strategyId).toBe("qual-sphb");
    // SIM: one win, one loss => 50% win rate, +2R and -1R => avg 0.5R.
    expect(perf.byTarget.SIM).toMatchObject({
      trades: 2,
      wins: 1,
      losses: 1,
      winRate: 0.5,
      avgR: 0.5,
      totalPnl: 100,
    });
    // PAPER: single win, no stop => win rate 1, avg R 0 (no R-defined trades).
    expect(perf.byTarget.PAPER).toMatchObject({
      trades: 1,
      winRate: 1,
      avgR: 0,
    });
    // LIVE has no closed trades — reported as empty, not omitted.
    expect(perf.byTarget.LIVE).toMatchObject({ trades: 0 });
  });
});

describe("DashboardService.setStrategy", () => {
  /** A minimal chainable fake over the Drizzle query builder. */
  function fakeDb(existing: Record<string, unknown> | null, closedTrades = 0) {
    const inserted: Array<Record<string, unknown>> = [];
    const updated: Array<Record<string, unknown>> = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (existing ? [existing] : []),
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            updated.push(values);
          },
        }),
      }),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          inserted.push(values);
        },
      }),
    };
    // countClosedTrades() goes through the raw tagged-template client.
    const sql = vi.fn(async () => [{ n: closedTrades }]);
    return {
      dbClient: { db, sql } as unknown as DbClient,
      inserted,
      updated,
    };
  }

  it("updates the row and writes an audit record", async () => {
    const { dbClient, inserted, updated } = fakeDb({
      id: "qual-sphb",
      name: "QUAL/SPHB",
      timeframe: "swing",
      mode: "WATCH",
      target: "SIM",
    });
    const svc = new DashboardService(dbClient, fakeSimulator([]));

    const result = await svc.setStrategy("qual-sphb", {
      mode: "APPROVE",
      target: "SIM",
    });

    expect(result).toMatchObject({
      id: "qual-sphb",
      mode: "APPROVE",
      target: "SIM",
    });
    expect(updated[0]).toMatchObject({ mode: "APPROVE", target: "SIM" });
    expect(inserted[0]).toMatchObject({
      entityType: "strategy",
      entityId: "qual-sphb",
      action: "config_change",
      actor: "user",
      before: { mode: "WATCH", target: "SIM" },
      after: { mode: "APPROVE", target: "SIM" },
    });
  });

  it("returns null and audits nothing for an unknown strategy", async () => {
    const { dbClient, inserted } = fakeDb(null);
    const svc = new DashboardService(dbClient, fakeSimulator([]));
    const result = await svc.setStrategy("nope", { mode: "APPROVE" });
    expect(result).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it("blocks an under-traded promotion and audits the rejection", async () => {
    const { dbClient, inserted, updated } = fakeDb(
      {
        id: "qual-sphb",
        name: "Q",
        timeframe: "swing",
        mode: "WATCH",
        target: "SIM",
      },
      3, // only 3 closed SIM trades
    );
    const svc = new DashboardService(dbClient, fakeSimulator([]));

    await expect(
      svc.setStrategy("qual-sphb", { target: "PAPER", note: "go" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_TRADES" });

    // Row untouched; the refused attempt is audited.
    expect(updated).toHaveLength(0);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      action: "promotion_rejected",
      after: { target: "PAPER", code: "INSUFFICIENT_TRADES", closedTrades: 3 },
    });
  });

  it("blocks a promotion with no review note", async () => {
    const { dbClient } = fakeDb(
      {
        id: "qual-sphb",
        name: "Q",
        timeframe: "swing",
        mode: "WATCH",
        target: "SIM",
      },
      100,
    );
    const svc = new DashboardService(dbClient, fakeSimulator([]));
    await expect(
      svc.setStrategy("qual-sphb", { target: "PAPER" }),
    ).rejects.toMatchObject({ code: "NOTE_REQUIRED" });
  });

  it("allows a promotion with enough trades and a note", async () => {
    const { dbClient, updated, inserted } = fakeDb(
      {
        id: "qual-sphb",
        name: "Q",
        timeframe: "swing",
        mode: "APPROVE",
        target: "SIM",
      },
      42,
    );
    const svc = new DashboardService(dbClient, fakeSimulator([]));

    const result = await svc.setStrategy("qual-sphb", {
      target: "PAPER",
      note: "42 clean SIM trades",
    });

    expect(result).toMatchObject({ target: "PAPER" });
    expect(updated[0]).toMatchObject({ target: "PAPER" });
    expect(inserted[0]).toMatchObject({
      action: "config_change",
      after: { target: "PAPER", note: "42 clean SIM trades" },
    });
  });
});
