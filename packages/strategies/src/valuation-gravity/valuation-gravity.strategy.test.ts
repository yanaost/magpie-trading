import { describe, it, expect } from "vitest";
import type {
  LLMAnalysis,
  MarketContext,
  QuantSignal,
  Ticker,
} from "@magpie/core";
import { ValuationGravityStrategy } from "./valuation-gravity.strategy.js";
import { StaticValuationDataProvider } from "./watchlist.js";
import { StaticCalendarProvider } from "../earnings-fade/calendar.js";

const WATCH = [
  { ticker: "RIVN", peer: "TSLA", rationale: "EV" },
  { ticker: "PLTR", peer: "SNOW", rationale: "software" },
] as const;

const PS = { RIVN: 3, TSLA: 6, PLTR: 24, SNOW: 12 };

/** A MarketContext whose only meaningful field is the clock. */
function ctx(nowIso: string): MarketContext {
  return {
    now: new Date(`${nowIso}T00:00:00.000Z`),
    target: "SIM",
    async candles() {
      return [];
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
  return new ValuationGravityStrategy(
    WATCH,
    new StaticCalendarProvider([
      { ticker: "RIVN", reportDate: "2024-05-07" },
      { ticker: "PLTR", reportDate: "2024-05-08" },
    ]),
    new StaticValuationDataProvider(PS),
  );
}

describe("ValuationGravityStrategy — WATCH-only, no order path", () => {
  it("is an observation strategy in WATCH mode", () => {
    const s = makeStrategy();
    expect(s.timeframe).toBe("observation");
    expect(s.defaultMode).toBe("WATCH");
  });

  it("buildProposal's return type is statically `never`", () => {
    // Compile-time proof there is no order-placement path (T2.8 AC): if the
    // return type were anything but `never`, this assignment would not compile.
    type Equal<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
    const _proposalIsNever: Equal<
      ReturnType<ValuationGravityStrategy["buildProposal"]>,
      never
    > = true;
    expect(_proposalIsNever).toBe(true);
  });

  it("buildProposal throws if ever reached at runtime", () => {
    const s = makeStrategy();
    const sig = {
      strategyId: s.id,
      ticker: "RIVN",
      trigger: {},
      quantMetrics: {},
    };
    const analysis: LLMAnalysis = {
      verdict: "proceed",
      confidence: 1,
      reasoning: "n/a",
      flaggedRisks: [],
    };
    expect(() => s.buildProposal(sig as QuantSignal, analysis)).toThrow(
      /never places orders/i,
    );
  });

  it("never manages a position (none can exist)", () => {
    const s = makeStrategy();
    const pos = {
      strategyId: s.id,
      target: "SIM" as const,
      ticker: "RIVN" as Ticker,
      status: "open" as const,
      side: "long" as const,
      qty: 0,
      avgEntryPrice: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      openedAt: new Date("2024-05-10T00:00:00.000Z"),
    };
    expect(s.manage(pos, ctx("2024-05-10"))).toBeNull();
  });

  it("emits an observation-only LLM prompt (no trade recommendation)", async () => {
    const s = makeStrategy();
    const [sig] = await s.scan(ctx("2024-05-10"));
    const req = s.llmPrompt(sig!);
    expect(req.prompt).toMatch(/observation only|do not recommend/i);
    expect(req.webSearch).toBe(false);
  });
});

describe("ValuationGravityStrategy — journaling", () => {
  it("journals each darling inside its two-week post-earnings window", async () => {
    const s = makeStrategy();
    const sigs = await s.scan(ctx("2024-05-10"));
    expect(sigs.map((x) => x.ticker).sort()).toEqual(["PLTR", "RIVN"]);
    const rivn = sigs.find((x) => x.ticker === "RIVN")!;
    expect(rivn.trigger.kind).toBe("valuation-journal");
    expect(rivn.trigger.peer).toBe("TSLA");
    expect(rivn.quantMetrics.psPremium).toBeCloseTo(0.5); // RIVN 3 / TSLA 6
  });

  it("emits nothing outside any window", async () => {
    const s = makeStrategy();
    expect(await s.scan(ctx("2024-06-30"))).toHaveLength(0);
  });

  it("produces journal entries across a quarter replay, deterministically", async () => {
    const s = makeStrategy();
    // Replay one session per week across Q2 2024 (Wednesdays).
    const sessions: string[] = [];
    for (let m = 4; m <= 6; m++) {
      const mm = String(m).padStart(2, "0");
      for (const dd of ["03", "10", "17", "24"])
        sessions.push(`2024-${mm}-${dd}`);
    }

    const run = async () => {
      const log: QuantSignal[] = [];
      for (const day of sessions) log.push(...(await s.scan(ctx(day))));
      return log;
    };

    const first = await run();
    const second = await run();

    // Entries were produced, and only inside the two-week windows.
    expect(first.length).toBeGreaterThan(0);
    // RIVN reported 05-07 → journaled on 05-10 & 05-17; PLTR 05-08 → 05-10 & 05-17.
    expect(first.filter((x) => x.ticker === "RIVN")).toHaveLength(2);
    expect(first.filter((x) => x.ticker === "PLTR")).toHaveLength(2);

    // Determinism: replaying the same quarter twice yields identical journals.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
