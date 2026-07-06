import { describe, it, expect } from "vitest";
import type { Candle, LLMAnalysis, MarketContext, Ticker } from "@magpie/core";
import { EarningsFadeStrategy } from "./earnings-fade.strategy.js";
import { StaticCalendarProvider, type EarningsEvent } from "./calendar.js";

const PROCEED: LLMAnalysis = {
  verdict: "proceed",
  confidence: 0.8,
  reasoning: "confirmed miss",
  flaggedRisks: [],
};

function bar(
  ticker: Ticker,
  isoDay: string,
  o: number,
  h: number,
  l: number,
  c: number,
): Candle {
  return {
    ticker,
    timeframe: "1d",
    ts: new Date(`${isoDay}T00:00:00.000Z`),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 5_000_000,
  };
}

/** MarketContext over a per-ticker candle map. */
function ctx(series: Map<Ticker, Candle[]>, now: Date): MarketContext {
  return {
    now,
    target: "SIM",
    async candles(ticker, _tf, limit) {
      const src = series.get(ticker) ?? [];
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

/*
 * A representative post-earnings-miss week, shaped after a real large-cap
 * guide-down (e.g. META's Feb-2022 report): a sharp reaction-day drop, then a
 * dead-cat bounce that stalls below the reaction high and rolls over. Prices are
 * representative (offline, not tick-accurate) — the pattern is what matters.
 */
const REPORT_DATE = "2022-02-02"; // reported after close → reaction next session
const META: Ticker = "META";
const metaWeek: Candle[] = [
  bar(META, "2022-02-01", 100, 101, 99, 100), // pre-report
  bar(META, "2022-02-03", 78, 80, 74, 74), // reaction: −26%, high 80
  bar(META, "2022-02-04", 76, 79, 74, 75.5), // dead-cat bounce to 79, closes red → stall
  bar(META, "2022-02-07", 75, 76, 70, 71), // continuation down
];

// A watchlist peer that reported but did NOT set up a fade (beat-and-hold).
const AAPL: Ticker = "AAPL";
const aaplWeek: Candle[] = [
  bar(AAPL, "2022-02-02", 170, 172, 169, 171),
  bar(AAPL, "2022-02-03", 176, 178, 175, 177), // gapped UP on a beat
  bar(AAPL, "2022-02-04", 177, 179, 176, 178.5),
];

const events: EarningsEvent[] = [
  { ticker: META, reportDate: REPORT_DATE, timing: "amc" },
  { ticker: AAPL, reportDate: "2022-02-02", timing: "amc" },
];

function makeStrategy() {
  return new EarningsFadeStrategy(new StaticCalendarProvider(events));
}

function makeCtx() {
  const series = new Map<Ticker, Candle[]>([
    [META, metaWeek],
    [AAPL, aaplWeek],
  ]);
  return ctx(series, new Date("2022-02-07T13:00:00.000Z"));
}

describe("EarningsFadeStrategy — metadata", () => {
  it("runs WATCH-first as a do-not-buy filter", () => {
    const s = makeStrategy();
    expect(s.id).toBe("earnings-fade");
    expect(s.defaultMode).toBe("WATCH");
  });

  it("universe is the deduped set of recent reporters", async () => {
    const u = await makeStrategy().universe(makeCtx());
    expect(u).toEqual([META, AAPL]);
  });
});

describe("EarningsFadeStrategy — dry run over one earnings week", () => {
  it("fires a fade only on the genuine post-earnings-miss stall", async () => {
    const signals = await makeStrategy().scan(makeCtx());
    // META stalls below its reaction high; AAPL beat and never set up.
    expect(signals).toHaveLength(1);
    const sig = signals[0]!;
    expect(sig.ticker).toBe(META);
    expect(sig.strategyId).toBe("earnings-fade");
    expect(sig.trigger.kind).toBe("post-earnings-stall");
    expect(sig.quantMetrics.reactionMovePct).toBeLessThan(-0.05);
    expect(sig.quantMetrics.postEarningsHigh).toBe(80);
  });

  it("emits a proceed/veto LLM prompt asking to confirm a real miss", async () => {
    const [sig] = await makeStrategy().scan(makeCtx());
    const req = makeStrategy().llmPrompt(sig!);
    expect(req.ticker).toBe(META);
    expect(req.prompt).toMatch(/miss or guide-down/i);
    expect(req.prompt).toMatch(/proceed|veto/i);
    expect(req.requiredChecks.length).toBeGreaterThan(0);
    expect(req.webSearch).toBe(true);
  });

  it("builds a fade (short) proposal: stop above the reaction high, target below", async () => {
    const strat = makeStrategy();
    const [sig] = await strat.scan(makeCtx());
    const draft = strat.buildProposal(sig!, PROCEED);
    expect(draft.ticker).toBe(META);
    expect(draft.side).toBe("short");
    expect(draft.entry).toBe(75.5); // stall close
    expect(draft.stop).toBeGreaterThan(80); // above the post-earnings high (80)
    expect(draft.target).toBeLessThan(draft.entry); // downside continuation
    expect(draft.exitPlan.stopLoss).toBe(draft.stop);
    // The do-not-buy / long-puts framing is written into the exit plan.
    expect(draft.exitPlan.rules.some((r) => /do not buy/i.test(r))).toBe(true);
    expect(draft.exitPlan.rules.some((r) => /put/i.test(r))).toBe(true);
  });

  it("produces no signal when the calendar is empty", async () => {
    const strat = new EarningsFadeStrategy(new StaticCalendarProvider([]));
    expect(await strat.scan(makeCtx())).toHaveLength(0);
  });
});
