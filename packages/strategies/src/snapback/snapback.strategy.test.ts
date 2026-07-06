import { describe, it, expect } from "vitest";
import type {
  Candle,
  LLMAnalysis,
  MarketContext,
  Position,
  Ticker,
} from "@magpie/core";
import {
  SnapbackStrategy,
  minutesOfDayUtc,
  shouldForceFlatten,
  DEFAULT_SNAPBACK_PARAMS,
} from "./snapback.strategy.js";
import {
  StaticPremarketScreener,
  type PremarketGapper,
} from "./premarket-screener.js";

const PROCEED: LLMAnalysis = {
  verdict: "proceed",
  confidence: 0.75,
  reasoning: "no fundamental news found — technical sympathy drop",
  flaggedRisks: [],
};

const TICK: Ticker = "SNAP";
const OPEN = new Date("2024-06-03T13:30:00.000Z");
const NOW = new Date(OPEN.getTime() + 9 * 5 * 60_000); // 14:15 UTC, 45 min in

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

const session: Candle[] = [
  bar5m(0, 96, 97, 1_000),
  bar5m(1, 94, 94, 1_000),
  bar5m(2, 92, 92.5, 1_000), // ORL = 92
  bar5m(3, 90, 91, 1_200), // day low = 90
  bar5m(4, 91, 92, 1_200),
  bar5m(5, 91.5, 93, 1_200),
  bar5m(6, 92, 93.5, 1_300),
  bar5m(7, 92.5, 94, 1_400),
  bar5m(8, 93, 94.5, 1_500),
  bar5m(9, 93.5, 95, 3_000), // reclaim 95, volume surge
];

// prevClose 110 → premarket 96 is a −12.7% gap, a $1B cap (in band).
const gapper: PremarketGapper = {
  ticker: TICK,
  prevClose: 110,
  premarketPrice: 96,
  marketCap: 1_000_000_000,
};

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
  return new SnapbackStrategy(new StaticPremarketScreener([gapper]));
}

describe("SnapbackStrategy — metadata", () => {
  it("runs AUTO intraday", () => {
    const s = makeStrategy();
    expect(s.id).toBe("snapback");
    expect(s.timeframe).toBe("intraday");
    expect(s.defaultMode).toBe("AUTO");
  });

  it("universe is the screened set of gappers", async () => {
    expect(await makeStrategy().universe(ctx(NOW))).toEqual([TICK]);
  });
});

describe("SnapbackStrategy — dry run", () => {
  it("fires on the no-news gap-down reclaim", async () => {
    const signals = await makeStrategy().scan(ctx(NOW));
    expect(signals).toHaveLength(1);
    const sig = signals[0]!;
    expect(sig.ticker).toBe(TICK);
    expect(sig.trigger.kind).toBe("snapback-reclaim");
    expect(sig.quantMetrics.dayLow).toBe(90);
    expect(sig.quantMetrics.reclaimPrice).toBe(95);
    expect(sig.quantMetrics.gapDownPct).toBeGreaterThan(0.1);
  });

  it("emits the highest-stakes news-veto LLM prompt", async () => {
    const [sig] = await makeStrategy().scan(ctx(NOW));
    const req = makeStrategy().llmPrompt(sig!);
    expect(req.ticker).toBe(TICK);
    expect(req.prompt).toMatch(/veto/i);
    expect(req.prompt).toMatch(/dilution|offering|lawsuit|earnings/i);
    expect(req.requiredChecks.length).toBeGreaterThanOrEqual(3);
    expect(req.webSearch).toBe(true);
  });

  it("builds a long: stop below the day low, target a half gap-fill", async () => {
    const strat = makeStrategy();
    const [sig] = await strat.scan(ctx(NOW));
    const draft = strat.buildProposal(sig!, PROCEED);
    expect(draft.side).toBe("long");
    expect(draft.entry).toBe(95); // reclaim close
    expect(draft.stop).toBe(89.1); // 90 × (1 − 0.01)
    expect(draft.target).toBe(102.5); // 95 + (110 − 95) × 0.5
    expect(draft.stop).toBeLessThan(sig!.quantMetrics.dayLow as number);
    expect(draft.exitPlan.timeStop?.flatByClose).toBe(true);
    expect(draft.exitPlan.rules.some((r) => /flatten|overnight/i.test(r))).toBe(
      true,
    );
  });

  it("produces no signal when the screener is empty", async () => {
    const strat = new SnapbackStrategy(new StaticPremarketScreener([]));
    expect(await strat.scan(ctx(NOW))).toHaveLength(0);
  });
});

describe("SnapbackStrategy — forced flatten", () => {
  const strat = makeStrategy();
  const position = {
    strategyId: "snapback",
    target: "SIM",
    ticker: TICK,
    side: "long",
    status: "open",
    qty: 100,
    avgEntryPrice: 95,
    realizedPnl: 0,
    unrealizedPnl: 0,
    openedAt: NOW,
  } as Position;

  it("holds mid-session (no forced exit yet)", () => {
    expect(strat.manage(position, ctx(NOW))).toBeNull();
  });

  it("force-closes once the flatten cutoff passes", () => {
    const nearClose = new Date("2024-06-03T19:55:00.000Z"); // 19:55 ≥ 19:50 cutoff
    const action = strat.manage(position, ctx(nearClose));
    expect(action).not.toBeNull();
    expect(action!.kind).toBe("close");
    expect(action!.reason).toMatch(/flatten/i);
  });
});

describe("snapback flatten helpers", () => {
  it("minutesOfDayUtc counts minutes from UTC midnight", () => {
    expect(minutesOfDayUtc(new Date("2024-06-03T19:50:00.000Z"))).toBe(1190);
  });

  it("flattens exactly at close − lead and after, not before", () => {
    const p = DEFAULT_SNAPBACK_PARAMS; // cutoff = 1200 − 10 = 1190 (19:50 UTC)
    expect(shouldForceFlatten(new Date("2024-06-03T19:49:00.000Z"), p)).toBe(
      false,
    );
    expect(shouldForceFlatten(new Date("2024-06-03T19:50:00.000Z"), p)).toBe(
      true,
    );
    expect(shouldForceFlatten(new Date("2024-06-03T20:00:00.000Z"), p)).toBe(
      true,
    );
  });
});
