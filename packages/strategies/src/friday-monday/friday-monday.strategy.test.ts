import { describe, it, expect } from "vitest";
import type {
  Candle,
  LLMAnalysis,
  MarketContext,
  Position,
  ProposalDraft,
  Ticker,
} from "@magpie/core";
import { FridayMondayFlowStrategy } from "./friday-monday.strategy.js";
import { StaticTrendingListProvider } from "./trending-list.js";
import { TradingCalendar } from "./trading-week.js";
import {
  flowExitDecision,
  DEFAULT_FRIDAY_MONDAY_PARAMS,
  type FlowView,
} from "./flow-detector.js";

const FLOW: Ticker = "FLOW";
const PROCEED: LLMAnalysis = {
  verdict: "proceed",
  confidence: 0.8,
  reasoning: "durable flow",
  flaggedRisks: [],
};

function bar(iso: string, o: number, h: number, l: number, c: number): Candle {
  return {
    ticker: FLOW,
    timeframe: "1d",
    ts: new Date(`${iso}T00:00:00.000Z`),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1_000_000,
  };
}

// Week of 2024-03-04..08 (a normal, holiday-free week) trending into a strong
// Friday close near the weekly high, then the following week's sessions.
const WEEK1: Candle[] = [
  bar("2024-03-04", 100, 101, 99, 100),
  bar("2024-03-05", 100, 103, 100, 102),
  bar("2024-03-06", 102, 105, 101, 104),
  bar("2024-03-07", 104, 107, 103, 106),
  bar("2024-03-08", 106, 110, 105, 109), // Fri close 109 near weekHigh 110, up day
];

/** MarketContext over a candle series (already sliced to `asOf`). */
function ctx(candles: Candle[], nowIso: string): MarketContext {
  return {
    now: new Date(`${nowIso}T00:00:00.000Z`),
    target: "SIM",
    async candles(_ticker, _tf, limit) {
      return limit ? candles.slice(-limit) : [...candles];
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
  return new FridayMondayFlowStrategy(
    new StaticTrendingListProvider([FLOW]),
    new TradingCalendar(), // holiday-free — the boundary logic is tested in trading-week.test
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
    openedAt: new Date("2024-03-11T00:00:00.000Z"),
  };
}

describe("FridayMondayFlowStrategy — signalling", () => {
  it("fires only on the Friday week-close, not mid-week", async () => {
    const strat = makeStrategy();

    // Thursday (not the week-close) → no signal even though it is near highs.
    const thu = await strat.scan(ctx(WEEK1.slice(0, 4), "2024-03-07"));
    expect(thu).toHaveLength(0);

    const fri = await strat.scan(ctx(WEEK1, "2024-03-08"));
    expect(fri).toHaveLength(1);
    const sig = fri[0]!;
    expect(sig.ticker).toBe(FLOW);
    expect(sig.trigger.kind).toBe("weekly-high-close");
    expect(sig.quantMetrics.fridayClose).toBe(109);
    expect(sig.quantMetrics.weekHigh).toBe(110);
  });

  it("does not fire when Friday closes weak (well below the weekly high)", async () => {
    const strat = makeStrategy();
    const weak = [...WEEK1.slice(0, 4), bar("2024-03-08", 106, 110, 100, 101)];
    expect(await strat.scan(ctx(weak, "2024-03-08"))).toHaveLength(0);
  });

  it("builds a long buy-stop proposal above Friday's high with flow exits", async () => {
    const strat = makeStrategy();
    const [sig] = await strat.scan(ctx(WEEK1, "2024-03-08"));
    const draft = strat.buildProposal(sig!, PROCEED);
    expect(draft.side).toBe("long");
    expect(draft.entry).toBe(110.11); // 110 × 1.001 buy-stop
    expect(draft.stop).toBe(104.64); // 109 × 0.96
    expect(draft.target).toBe(115.54); // 109 × 1.06
    expect(draft.exitPlan.rules.some((r) => /auto-cancel/i.test(r))).toBe(true);
    expect(draft.exitPlan.rules.some((r) => /second weekend/i.test(r))).toBe(
      true,
    );
  });

  it("emits a proceed/veto LLM prompt about durable flow", async () => {
    const strat = makeStrategy();
    const [sig] = await strat.scan(ctx(WEEK1, "2024-03-08"));
    const req = strat.llmPrompt(sig!);
    expect(req.prompt).toMatch(/flow/i);
    expect(req.prompt).toMatch(/proceed or veto/i);
    expect(req.webSearch).toBe(true);
  });
});

describe("FridayMondayFlowStrategy — Monday auto-cancel (integration)", () => {
  it("flattens the position when Monday opens weak", async () => {
    const strat = makeStrategy();
    const [sig] = await strat.scan(ctx(WEEK1, "2024-03-08"));
    const pos = positionFrom(strat.buildProposal(sig!, PROCEED));

    // Monday 2024-03-11 gaps down and opens weak (below Friday's 109).
    const monday = [...WEEK1, bar("2024-03-11", 104, 105, 102, 103)];
    await strat.scan(ctx(monday, "2024-03-11")); // refreshes the sync-manage view
    const action = strat.manage(pos, ctx(monday, "2024-03-11"));
    expect(action?.kind).toBe("close");
    expect(action?.reason).toMatch(/auto-cancel/i);
  });

  it("holds when Monday opens strong and confirms the flow", async () => {
    const strat = makeStrategy();
    const [sig] = await strat.scan(ctx(WEEK1, "2024-03-08"));
    const pos = positionFrom(strat.buildProposal(sig!, PROCEED));

    // Monday opens up and stays under the +6% target → hold.
    const monday = [...WEEK1, bar("2024-03-11", 110, 112, 109, 111)];
    await strat.scan(ctx(monday, "2024-03-11"));
    expect(strat.manage(pos, ctx(monday, "2024-03-11"))).toBeNull();
  });
});

describe("flowExitDecision — exit rules", () => {
  const P = DEFAULT_FRIDAY_MONDAY_PARAMS;
  const MID: FlowView = {
    asOf: new Date("2024-03-12T00:00:00.000Z"),
    todayOpen: 111,
    todayHigh: 113,
    todayClose: 112,
    isWeekOpen: false,
    isWeekClose: false,
    priorWeekClose: 109,
  };

  it("holds a healthy mid-week position", () => {
    expect(flowExitDecision(MID, P)).toBeNull();
  });

  it("auto-cancels on a weak Monday open", () => {
    const view: FlowView = { ...MID, isWeekOpen: true, todayOpen: 104 };
    expect(flowExitDecision(view, P)?.reason).toMatch(/auto-cancel/i);
  });

  it("exits into mid-week strength at the target", () => {
    const view: FlowView = { ...MID, todayHigh: 116 }; // ≥ 109 × 1.06 = 115.54
    expect(flowExitDecision(view, P)?.reason).toMatch(/strength/i);
  });

  it("time-stops at the end of the week", () => {
    const view: FlowView = { ...MID, isWeekClose: true };
    expect(flowExitDecision(view, P)?.reason).toMatch(/time stop/i);
  });

  it("weak-open auto-cancel outranks a strength spike the same session", () => {
    const view: FlowView = {
      ...MID,
      isWeekOpen: true,
      todayOpen: 104, // weak
      todayHigh: 120, // also above target
    };
    expect(flowExitDecision(view, P)?.reason).toMatch(/auto-cancel/i);
  });
});
