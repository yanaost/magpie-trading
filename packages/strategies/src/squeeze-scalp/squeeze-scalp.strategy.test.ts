import { describe, it, expect } from "vitest";
import type {
  Candle,
  LLMAnalysis,
  MarketContext,
  Position,
  Ticker,
} from "@magpie/core";
import { SqueezeScalpStrategy } from "./squeeze-scalp.strategy.js";
import {
  StaticShortInterestProvider,
  type ShortInterestDatum,
} from "./short-interest.js";

const PROCEED: LLMAnalysis = {
  verdict: "proceed",
  confidence: 0.8,
  reasoning: "verified signed-contract catalyst, real volume",
  flaggedRisks: [],
};

const TICK: Ticker = "SQZ";
const OPEN = new Date("2024-06-03T13:30:00.000Z");
const NOW = new Date(OPEN.getTime() + 6 * 5 * 60_000);

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

const session: Candle[] = [
  bar5m(0, 20.3, 20.0, 1_000),
  bar5m(1, 20.4, 20.1, 1_000),
  bar5m(2, 20.5, 20.2, 1_000),
  bar5m(3, 20.4, 20.1, 1_000),
  bar5m(4, 20.5, 20.3, 1_000),
  bar5m(5, 20.4, 20.2, 1_000),
  bar5m(6, 21.4, 21.2, 3_000), // break above 20.5 on 3× volume
];

const roster: ShortInterestDatum[] = [
  { ticker: TICK, shortInterestPctFloat: 0.32, asOf: "2024-06-02" },
];

function ctx(now: Date): MarketContext {
  return {
    now,
    target: "SIM",
    async candles(ticker, _tf, limit) {
      const src = ticker === TICK ? session : [];
      return limit ? src.slice(-limit) : [...src];
    },
    async latestQuote() {
      return null;
    },
    async accountEquity() {
      return 100_000;
    },
    async openPositions() {
      return [];
    },
  };
}

function makeStrategy() {
  return new SqueezeScalpStrategy(new StaticShortInterestProvider(roster));
}

function positionAt(qty: number): Position {
  return {
    strategyId: "squeeze-scalp",
    target: "SIM",
    ticker: TICK,
    side: "long",
    status: "open",
    qty,
    avgEntryPrice: 21.2,
    realizedPnl: 0,
    unrealizedPnl: 0,
    openedAt: NOW,
  } as Position;
}

describe("SqueezeScalpStrategy — metadata", () => {
  it("runs AUTO intraday", () => {
    const s = makeStrategy();
    expect(s.id).toBe("squeeze-scalp");
    expect(s.timeframe).toBe("intraday");
    expect(s.defaultMode).toBe("AUTO");
  });

  it("universe is the high-short-interest roster", async () => {
    expect(await makeStrategy().universe(ctx(NOW))).toEqual([TICK]);
  });
});

describe("SqueezeScalpStrategy — dry run", () => {
  it("fires on a catalyst breakout in a high-SI name", async () => {
    const signals = await makeStrategy().scan(ctx(NOW));
    expect(signals).toHaveLength(1);
    const sig = signals[0]!;
    expect(sig.trigger.kind).toBe("squeeze-breakout");
    expect(sig.quantMetrics.resistance).toBe(20.5);
    expect(sig.quantMetrics.breakoutPrice).toBe(21.2);
    expect(sig.quantMetrics.shortInterestPctFloat).toBe(0.32);
  });

  it("emits the pump-vs-real-news veto prompt", async () => {
    const [sig] = await makeStrategy().scan(ctx(NOW));
    const req = makeStrategy().llmPrompt(sig!);
    expect(req.prompt).toMatch(/veto/i);
    expect(req.prompt).toMatch(/pump|social-media|manipulation/i);
    expect(req.requiredChecks.length).toBeGreaterThanOrEqual(3);
    expect(req.webSearch).toBe(true);
  });

  it("builds a long with a tight stop and a runner target", async () => {
    const strat = makeStrategy();
    const [sig] = await strat.scan(ctx(NOW));
    const draft = strat.buildProposal(sig!, PROCEED);
    expect(draft.side).toBe("long");
    expect(draft.entry).toBe(21.2);
    expect(draft.stop).toBe(20.56); // 21.2 × (1 − 0.03)
    expect(draft.target).toBe(23.32); // 21.2 × 1.10
    // Tight-stop distance is 2–4% per spec.
    const stopPct = (draft.entry - draft.stop) / draft.entry;
    expect(stopPct).toBeGreaterThanOrEqual(0.02);
    expect(stopPct).toBeLessThanOrEqual(0.04);
    expect(draft.exitPlan.rules.some((r) => /scale out/i.test(r))).toBe(true);
    expect(draft.exitPlan.rules.some((r) => /chase guard/i.test(r))).toBe(true);
  });

  it("does not fire the chase guard's extended names", async () => {
    // A name up ~55% on the day (open far below the break) is vetoed.
    const extended = session.map((c, i) =>
      i === 0 ? { ...c, open: 13.7 } : c,
    );
    const s = new SqueezeScalpStrategy(new StaticShortInterestProvider(roster));
    const chaseCtx: MarketContext = {
      ...ctx(NOW),
      async candles() {
        return extended;
      },
    };
    expect(await s.scan(chaseCtx)).toHaveLength(0);
  });
});

describe("SqueezeScalpStrategy — scaled exits (manage)", () => {
  it("holds a fresh position that has not moved", async () => {
    const strat = makeStrategy();
    await strat.scan(ctx(NOW)); // primes the price cache at 21.2 (entry)
    expect(strat.manage(positionAt(100), ctx(NOW))).toBeNull();
  });

  it("banks the first tranche once up +5%", async () => {
    const strat = makeStrategy();
    // Cache a price ~+5% above the 21.2 entry via a lifted final bar.
    const lifted = session.map((c, i) =>
      i === session.length - 1 ? { ...c, close: 22.3 } : c,
    );
    const liftedCtx: MarketContext = {
      ...ctx(NOW),
      async candles() {
        return lifted;
      },
    };
    await strat.scan(liftedCtx);
    const action = strat.manage(positionAt(100), liftedCtx);
    expect(action).not.toBeNull();
    expect(action!.kind).toBe("scale-out");
    expect((action as { qty: number }).qty).toBe(50);
  });

  it("closes the runner once up +10%", async () => {
    const strat = makeStrategy();
    const ripped = session.map((c, i) =>
      i === session.length - 1 ? { ...c, close: 23.4 } : c,
    );
    const rippedCtx: MarketContext = {
      ...ctx(NOW),
      async candles() {
        return ripped;
      },
    };
    await strat.scan(rippedCtx);
    const action = strat.manage(positionAt(50), rippedCtx);
    expect(action).not.toBeNull();
    expect(action!.kind).toBe("close");
  });

  it("holds when there is no cached price for the ticker", () => {
    // No scan has run → the view cache is empty.
    expect(makeStrategy().manage(positionAt(100), ctx(NOW))).toBeNull();
  });
});
