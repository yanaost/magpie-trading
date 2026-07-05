import { describe, expect, it } from "vitest";
import { TickerSchema, CandleSchema } from "./market.js";
import { ProposalDraftSchema, TradeProposalSchema } from "./proposal.js";
import { ExitActionSchema, PositionSchema } from "./position.js";
import {
  BracketOrderRequestSchema,
  LivePromotionLockedError,
} from "./execution.js";

describe("TickerSchema", () => {
  it.each(["QUAL", "SPHB", "BRK.B", "BF-B"])("accepts %s", (t) => {
    expect(TickerSchema.parse(t)).toBe(t);
  });

  it.each(["", "lower", "TOO-LONG-SYMBOL-X", "A B"])("rejects %p", (t) => {
    expect(() => TickerSchema.parse(t)).toThrow();
  });
});

describe("CandleSchema", () => {
  it("coerces an ISO timestamp to a Date", () => {
    const c = CandleSchema.parse({
      ticker: "QUAL",
      timeframe: "1d",
      ts: "2026-07-01T00:00:00Z",
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1_000,
    });
    expect(c.ts).toBeInstanceOf(Date);
  });

  it("rejects negative volume", () => {
    expect(() =>
      CandleSchema.parse({
        ticker: "QUAL",
        timeframe: "1d",
        ts: new Date(),
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: -1,
      }),
    ).toThrow();
  });
});

const draft = {
  strategyId: "qual-sphb",
  ticker: "QUAL",
  side: "long" as const,
  requestedQty: 100,
  entry: 150,
  stop: 147,
  exitPlan: { stopLoss: 147, rules: ["exit under 5d MA"] },
};

describe("ProposalDraftSchema", () => {
  it("accepts a draft with a mandatory stop + exit plan", () => {
    const d = ProposalDraftSchema.parse(draft);
    expect(d.exitPlan.stopLoss).toBe(147);
  });

  it("rejects a draft without a stop", () => {
    const { stop: _stop, ...noStop } = draft;
    expect(() => ProposalDraftSchema.parse(noStop)).toThrow();
  });

  it("rejects a draft without an exit plan", () => {
    const { exitPlan: _exitPlan, ...noExit } = draft;
    expect(() => ProposalDraftSchema.parse(noExit)).toThrow();
  });
});

describe("TradeProposalSchema", () => {
  it("defaults status to pending and coerces expiry", () => {
    const p = TradeProposalSchema.parse({
      strategyId: "qual-sphb",
      ticker: "QUAL",
      side: "long",
      qty: 100,
      entry: 150,
      stop: 147,
      exitPlan: { stopLoss: 147, rules: [] },
      riskUsd: 300,
      riskPct: 1,
      executionTarget: "SIM",
      expiry: "2026-07-05T20:00:00Z",
    });
    expect(p.status).toBe("pending");
    expect(p.expiry).toBeInstanceOf(Date);
  });
});

describe("PositionSchema", () => {
  it("defaults status/pnl and allows zero qty when closed", () => {
    const pos = PositionSchema.parse({
      strategyId: "qual-sphb",
      target: "SIM",
      ticker: "QUAL",
      side: "long",
      qty: 0,
      avgEntryPrice: 150,
      openedAt: new Date(),
    });
    expect(pos.status).toBe("open");
    expect(pos.realizedPnl).toBe(0);
    expect(pos.unrealizedPnl).toBe(0);
  });
});

describe("ExitActionSchema", () => {
  it("accepts each discriminated variant", () => {
    expect(
      ExitActionSchema.parse({ kind: "close", reason: "time stop" }).kind,
    ).toBe("close");
    expect(
      ExitActionSchema.parse({
        kind: "modify-stop",
        newStopPrice: 149,
        reason: "trail",
      }).kind,
    ).toBe("modify-stop");
    expect(
      ExitActionSchema.parse({
        kind: "scale-out",
        qty: 50,
        reason: "half off",
      }).kind,
    ).toBe("scale-out");
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      ExitActionSchema.parse({ kind: "yolo", reason: "x" }),
    ).toThrow();
  });

  it("requires a reason", () => {
    expect(() => ExitActionSchema.parse({ kind: "close" })).toThrow();
  });
});

describe("BracketOrderRequestSchema", () => {
  const base = {
    strategyId: "qual-sphb",
    target: "SIM" as const,
    ticker: "QUAL",
    side: "long" as const,
    qty: 100,
    stopPrice: 147,
  };

  it("requires a limitPrice for a limit entry", () => {
    expect(() =>
      BracketOrderRequestSchema.parse({ ...base, entryType: "limit" }),
    ).toThrow(/limitPrice/);
  });

  it("accepts a market entry without a limit price and defaults TIF", () => {
    const r = BracketOrderRequestSchema.parse({
      ...base,
      entryType: "market",
    });
    expect(r.timeInForce).toBe("DAY");
  });

  it("always requires a stop price (exit-before-entry)", () => {
    const { stopPrice: _stopPrice, ...noStop } = base;
    expect(() =>
      BracketOrderRequestSchema.parse({ ...noStop, entryType: "market" }),
    ).toThrow();
  });
});

describe("LivePromotionLockedError", () => {
  it("is an Error with a named type and helpful message", () => {
    const e = new LivePromotionLockedError("SIM port refuses LIVE");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("LivePromotionLockedError");
    expect(e.message).toMatch(/LIVE execution is locked/);
    expect(e.message).toMatch(/SIM port refuses LIVE/);
  });

  it("works with no detail argument", () => {
    const e = new LivePromotionLockedError();
    expect(e.message).toMatch(/LIVE execution is locked\./);
  });
});
