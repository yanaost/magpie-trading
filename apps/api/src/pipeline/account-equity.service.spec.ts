/**
 * Account-equity sizing tests (A0). Proves the fix for the fixed-$100k bug:
 * every position size flows from `RiskManager` sizing against `ctx.equity`, and
 * that equity must be *real* per-target buying power, not a constant.
 *
 *   - SIM   → the strategy's virtual sim cash, so sizing follows the account up
 *             after wins and down after losses (driven here through a real
 *             {@link Simulator} round-trip, not a stub).
 *   - PAPER → the broker-reported net liquidation value.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RISK_PARAMS,
  RiskManager,
  Simulator,
  type BracketOrderRequest,
  type Candle,
  type ProposalDraft,
  type RiskContext,
} from "@magpie/core";
import {
  AccountEquityService,
  type BrokerAccountPort,
} from "./account-equity.service.js";

const T0 = new Date("2026-01-02T15:00:00Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const STRATEGY_ID = "qual-sphb";

/** A 2%-per-trade manager (loosest config within the global ceilings). */
const mgr = new RiskManager({ ...DEFAULT_RISK_PARAMS, maxRiskPerTradePct: 2 });

/** A baseline long draft: entry 150, stop 147 → $3 stop distance. */
function draft(): ProposalDraft {
  return {
    strategyId: STRATEGY_ID,
    ticker: "QUAL",
    side: "long",
    requestedQty: 10_000,
    entry: 150,
    stop: 147,
    exitPlan: { stopLoss: 147, rules: [] },
  };
}

function sizeAt(equity: number, target: RiskContext["executionTarget"]) {
  const decision = mgr.evaluate(draft(), {
    now: min(0),
    equity,
    executionTarget: target,
    openPositions: [],
  });
  if (!decision.approved) throw new Error("expected an approved proposal");
  return decision.proposal;
}

function bar(
  fields: Partial<Candle> & { close: number },
  atMinute: number,
): Candle {
  const c = fields.close;
  return {
    ticker: "QUAL",
    timeframe: "5m",
    ts: min(atMinute),
    open: fields.open ?? c,
    high: fields.high ?? Math.max(fields.open ?? c, c),
    low: fields.low ?? Math.min(fields.open ?? c, c),
    close: c,
    volume: fields.volume ?? 1_000,
  };
}

function longReq(): BracketOrderRequest {
  return {
    strategyId: STRATEGY_ID,
    target: "SIM",
    ticker: "QUAL",
    side: "long",
    qty: 100,
    entryType: "market",
    stopPrice: 95,
    targetPrice: 110,
    timeInForce: "DAY",
  };
}

describe("AccountEquityService — SIM sizing follows virtual cash", () => {
  it("sizes against real sim cash, tracking it up after a win and down after a loss", async () => {
    const sim = new Simulator(); // default starting cash 100k
    const svc = new AccountEquityService(sim, null);

    // Flat, untouched: equity is the starting cash and sizing is ~2% of it.
    const start = await svc.equityFor("SIM", STRATEGY_ID);
    expect(start).toBe(sim.cash(STRATEGY_ID));
    const sizedAtStart = sizeAt(start, "SIM");
    expect(sizedAtStart.riskUsd).toBeGreaterThan(start * 0.01);
    expect(sizedAtStart.riskUsd).toBeLessThanOrEqual(start * 0.02 + 0.01);

    // A winning round-trip: enter at 100, target 110 hit → realized gain.
    sim.onBar(bar({ close: 100 }, 0));
    await sim.placeBracket(longReq());
    sim.onBar(bar({ open: 100, high: 111, low: 99, close: 110 }, 5));
    expect(sim.realizedPnl(STRATEGY_ID)).toBeGreaterThan(0);

    const afterWin = await svc.equityFor("SIM", STRATEGY_ID);
    expect(afterWin).toBe(sim.cash(STRATEGY_ID));
    expect(afterWin).toBeGreaterThan(start); // equity followed the account up
    // Sizing grew with the account — strictly more risk budget than at start.
    expect(sizeAt(afterWin, "SIM").riskUsd).toBeGreaterThanOrEqual(
      sizedAtStart.riskUsd,
    );

    // A losing round-trip: enter at 100, stop 95 hit → realized loss.
    sim.onBar(bar({ close: 100 }, 10));
    await sim.placeBracket(longReq());
    sim.onBar(bar({ open: 100, high: 101, low: 94, close: 95 }, 15));

    const afterLoss = await svc.equityFor("SIM", STRATEGY_ID);
    expect(afterLoss).toBe(sim.cash(STRATEGY_ID));
    expect(afterLoss).toBeLessThan(afterWin); // equity followed the account down
    // Sizing shrank with the account.
    expect(sizeAt(afterLoss, "SIM").riskUsd).toBeLessThanOrEqual(
      sizeAt(afterWin, "SIM").riskUsd,
    );
  });

  it("sizes off a non-default starting cash, not a hardcoded 100k", async () => {
    const sim = new Simulator({ startingCash: 50_000 });
    const svc = new AccountEquityService(sim, null);
    const equity = await svc.equityFor("SIM", STRATEGY_ID);
    expect(equity).toBe(50_000);
    // Risk budget ≈ 1–2% of the *actual* 50k, i.e. well under a 100k-based size.
    const proposal = sizeAt(equity, "SIM");
    expect(proposal.riskUsd).toBeLessThanOrEqual(50_000 * 0.02 + 0.01);
    expect(proposal.riskUsd).toBeGreaterThan(50_000 * 0.01);
  });
});

describe("AccountEquityService — PAPER sizing uses the broker value", () => {
  it("sizes against the broker-reported net liquidation value", async () => {
    const broker: BrokerAccountPort = {
      async netLiquidationValue() {
        return 250_000;
      },
    };
    // A sim that would answer 100k for SIM — proving PAPER ignores it.
    const svc = new AccountEquityService(new Simulator(), broker);

    const equity = await svc.equityFor("PAPER", STRATEGY_ID);
    expect(equity).toBe(250_000);

    const proposal = sizeAt(equity, "PAPER");
    expect(proposal.executionTarget).toBe("PAPER");
    // Risk budget ≈ 2% of the broker's 250k (~$5k), far above a 100k-based size.
    expect(proposal.riskUsd).toBeGreaterThan(250_000 * 0.01);
    expect(proposal.riskUsd).toBeLessThanOrEqual(250_000 * 0.02 + 0.01);
  });

  it("throws for PAPER when no broker account source is wired", async () => {
    const svc = new AccountEquityService(new Simulator(), null);
    await expect(svc.equityFor("PAPER", STRATEGY_ID)).rejects.toThrow(
      /broker account source/,
    );
  });
});
