import { describe, it, expect } from "vitest";
import type {
  Candle,
  LLMAnalysis,
  MarketContext,
  Position,
  ProposalDraft,
  Ticker,
} from "@magpie/core";
import { HypeMomentumStrategy } from "./hype-momentum.strategy.js";
import {
  StaticHypeCandidateProvider,
  StaticEarningsSchedule,
} from "./candidates.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = Date.parse("2024-05-01T00:00:00.000Z");
const HYPE: Ticker = "HYPE";
const PROCEED: LLMAnalysis = {
  verdict: "proceed",
  confidence: 0.8,
  reasoning: "real catalyst, early",
  flaggedRisks: [],
};

function bar(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
  vol: number,
): Candle {
  return {
    ticker: HYPE,
    timeframe: "1d",
    ts: new Date(BASE + i * DAY_MS),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: vol,
  };
}

/**
 * A fixtured spike week: 21 flat base sessions (~100, 1M shares), a day-21
 * volume-spike breakout, a healthy day-22 follow-through, then a day-23
 * heavy-volume red distribution day that ends the run.
 */
const SERIES: Candle[] = [
  ...Array.from({ length: 21 }, (_, i) => bar(i, 100, 101, 99, 100, 1_000_000)),
  bar(21, 101, 109, 100, 108, 3_000_000), // breakout: +8%, 3× volume, up day
  bar(22, 108, 113, 107, 112, 1_500_000), // follow-through, still advancing
  bar(23, 112, 113, 104, 106, 2_000_000), // heavy-volume red day → stall
];

/** MarketContext over SERIES, capped to `[0, asOf]` (week-by-week replay). */
function ctx(asOf: number): MarketContext {
  return {
    now: new Date(BASE + asOf * DAY_MS),
    target: "SIM",
    async candles(_ticker, _tf, limit) {
      const visible = SERIES.slice(0, asOf + 1);
      return limit ? visible.slice(-limit) : visible;
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

function makeStrategy(earnings = new StaticEarningsSchedule()) {
  return new HypeMomentumStrategy(
    new StaticHypeCandidateProvider([HYPE]),
    earnings,
  );
}

function positionFrom(draft: ProposalDraft, qty = 100): Position {
  return {
    strategyId: draft.strategyId,
    target: "SIM",
    ticker: draft.ticker,
    side: draft.side,
    status: "open",
    qty,
    avgEntryPrice: draft.entry,
    realizedPnl: 0,
    unrealizedPnl: 0,
    openedAt: new Date(BASE + 21 * DAY_MS),
  };
}

describe("HypeMomentumStrategy — metadata", () => {
  it("scans its injected candidate watchlist", async () => {
    expect(await makeStrategy().universe(ctx(23))).toEqual([HYPE]);
  });

  it("is a swing strategy", () => {
    const s = makeStrategy();
    expect(s.id).toBe("hype-momentum");
    expect(s.timeframe).toBe("swing");
  });
});

describe("HypeMomentumStrategy — fixtured spike week", () => {
  it("fires exactly one signal on the fresh breakout, not the day after", async () => {
    const strat = makeStrategy();

    const before = await strat.scan(ctx(20)); // pre-breakout
    expect(before).toHaveLength(0);

    const atSpike = await strat.scan(ctx(21));
    expect(atSpike).toHaveLength(1);
    const sig = atSpike[0]!;
    expect(sig.ticker).toBe(HYPE);
    expect(sig.trigger.kind).toBe("volume-spike-breakout");
    expect(sig.quantMetrics.volMult).toBeGreaterThanOrEqual(2.5);

    const dayAfter = await strat.scan(ctx(22)); // still up, but not a fresh spike
    expect(dayAfter).toHaveLength(0);
  });

  it("builds a long breakout proposal with pre-written exits", async () => {
    const strat = makeStrategy();
    const [sig] = await strat.scan(ctx(21));
    const draft = strat.buildProposal(sig!, PROCEED);
    expect(draft.side).toBe("long");
    expect(draft.entry).toBe(108);
    expect(draft.target).toBe(124.2); // +15%
    expect(draft.stop).toBe(99.36); // −8%
    expect(draft.exitPlan.rules.some((r) => /\+15%/.test(r))).toBe(true);
    expect(draft.exitPlan.rules.some((r) => /5-day MA/.test(r))).toBe(true);
    expect(draft.exitPlan.rules.some((r) => /earnings/i.test(r))).toBe(true);
  });

  it("emits a proceed/veto LLM prompt asking for a real, early-stage catalyst", async () => {
    const strat = makeStrategy();
    const [sig] = await strat.scan(ctx(21));
    const req = strat.llmPrompt(sig!);
    expect(req.prompt).toMatch(/catalyst/i);
    expect(req.prompt).toMatch(/early-stage/i);
    expect(req.prompt).toMatch(/proceed or veto/i);
    expect(req.webSearch).toBe(true);
  });

  it("holds through the follow-through, then exits on the heavy-volume red day", async () => {
    const strat = makeStrategy();
    const [sig] = await strat.scan(ctx(21));
    const pos = positionFrom(strat.buildProposal(sig!, PROCEED));

    await strat.scan(ctx(22)); // refresh cache: healthy follow-through
    expect(strat.manage(pos, ctx(22))).toBeNull();

    await strat.scan(ctx(23)); // heavy-volume red distribution day
    const action = strat.manage(pos, ctx(23));
    expect(action?.kind).toBe("close");
    expect(action?.reason).toMatch(/heavy-volume red/i);
  });

  it("HARD-exits before an upcoming earnings date, overriding a healthy hold", async () => {
    // Earnings on day-24 (2024-05-25); at day-22 (2024-05-23) that is 2 days out.
    const strat = makeStrategy(
      new StaticEarningsSchedule({ [HYPE]: "2024-05-25" }),
    );
    const [sig] = await strat.scan(ctx(21));
    const pos = positionFrom(strat.buildProposal(sig!, PROCEED));

    await strat.scan(ctx(22)); // healthy day, but earnings loom
    const action = strat.manage(pos, ctx(22));
    expect(action?.kind).toBe("close");
    expect(action?.reason).toMatch(/earnings/i);
  });
});
