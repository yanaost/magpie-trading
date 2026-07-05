import { describe, it, expect } from "vitest";
import type {
  Candle,
  LLMAnalysis,
  MarketContext,
  Position,
  ProposalDraft,
} from "@magpie/core";
import {
  QualSphbStrategy,
  DEFAULT_QUAL_SPHB_PARAMS,
} from "./qual-sphb.strategy.js";
import { ratioView } from "./indicators.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BASE = Date.parse("2024-01-01T00:00:00.000Z");
const PROCEED: LLMAnalysis = {
  verdict: "proceed",
  confidence: 0.8,
  reasoning: "clear",
  flaggedRisks: [],
};

function bar(ticker: "QUAL" | "SPHB", close: number, i: number): Candle {
  return {
    ticker,
    timeframe: "1w",
    ts: new Date(BASE + i * WEEK_MS),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

/**
 * A read-only MarketContext over full SPHB/QUAL close arrays. `asOf` caps the
 * visible history to `[0, asOf]` (inclusive), mimicking week-by-week replay.
 */
function ctx(
  sphbCloses: number[],
  qualCloses: number[],
  asOf = sphbCloses.length - 1,
): MarketContext {
  const sphb = sphbCloses.map((c, i) => bar("SPHB", c, i));
  const qual = qualCloses.map((c, i) => bar("QUAL", c, i));
  return {
    now: new Date(BASE + asOf * WEEK_MS),
    target: "SIM",
    async candles(ticker, _tf, limit) {
      const src = ticker === "SPHB" ? sphb : qual;
      const visible = src.slice(0, asOf + 1);
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
    openedAt: new Date(BASE),
  };
}

describe("QualSphbStrategy — synthetic fixture", () => {
  const P = DEFAULT_QUAL_SPHB_PARAMS;
  // Warm-up: 20 weeks with ratio 1.0 (SPHB 100 / QUAL 100), then a stretch.
  const warm = P.smaWeeks;
  const qualCloses = Array.from({ length: warm + 3 }, () => 100);
  // SPHB: flat 100 through warm-up, jump to 110 (ratio 1.1 > band), hold, then revert.
  const sphbCloses = [
    ...Array.from({ length: warm }, () => 100),
    110, // week `warm`: fresh cross above 5% band → signal
    110, // week warm+1: still extended → no *new* signal (fresh-cross only)
    100, // week warm+2: reverts to SMA → manage exits
  ];

  it("universe is the QUAL/SPHB pair", async () => {
    const u = await new QualSphbStrategy().universe();
    expect(u).toContain("QUAL");
    expect(u).toContain("SPHB");
  });

  it("fires exactly one signal on the fresh stretch above the band", async () => {
    const strat = new QualSphbStrategy();

    const atCross = await strat.scan(ctx(sphbCloses, qualCloses, warm));
    expect(atCross).toHaveLength(1);
    const sig = atCross[0]!;
    expect(sig.ticker).toBe("QUAL");
    expect(sig.strategyId).toBe("qual-sphb");
    expect(sig.quantMetrics.ratio).toBeCloseTo(1.1, 10);
    expect(sig.quantMetrics.stretchPct).toBeGreaterThan(P.entryBand);

    // Still extended one week later — no *new* signal.
    const held = await strat.scan(ctx(sphbCloses, qualCloses, warm + 1));
    expect(held).toHaveLength(0);
  });

  it("does not fire before the SMA warms up", async () => {
    const strat = new QualSphbStrategy();
    const early = await strat.scan(ctx(sphbCloses, qualCloses, warm - 5));
    expect(early).toHaveLength(0);
  });

  it("builds a long-QUAL proposal with a stop below entry", async () => {
    const strat = new QualSphbStrategy();
    const [sig] = await strat.scan(ctx(sphbCloses, qualCloses, warm));
    const draft = strat.buildProposal(sig!, PROCEED);
    expect(draft.ticker).toBe("QUAL");
    expect(draft.side).toBe("long");
    expect(draft.entry).toBe(100);
    expect(draft.stop).toBe(92); // 8% below
    expect(draft.exitPlan.stopLoss).toBe(92);
    expect(draft.exitPlan.rules.some((r) => r.includes("revert"))).toBe(true);
  });

  it("emits a proceed/veto-only LLM prompt carrying the ratio context", async () => {
    const strat = new QualSphbStrategy();
    const [sig] = await strat.scan(ctx(sphbCloses, qualCloses, warm));
    const req = strat.llmPrompt(sig!);
    expect(req.strategyId).toBe("qual-sphb");
    expect(req.ticker).toBe("QUAL");
    expect(req.prompt).toMatch(/proceed or veto/i);
    expect(req.context.ratio).toBeCloseTo(1.1, 10);
    expect(req.requiredChecks.length).toBeGreaterThan(0);
    expect(req.webSearch).toBe(true);
  });

  it("throws when no QUAL close is available to price the entry", () => {
    const strat = new QualSphbStrategy();
    // A signal with no qualClose metric and no prior scan to fall back on.
    const orphan = {
      strategyId: "qual-sphb",
      ticker: "QUAL" as const,
      trigger: { kind: "ratio-stretch" },
      quantMetrics: {},
    };
    expect(() => strat.buildProposal(orphan, PROCEED)).toThrow(
      /no QUAL close/i,
    );
  });

  it("holds while extended, then exits when the ratio reverts to its SMA", async () => {
    const strat = new QualSphbStrategy();
    const [sig] = await strat.scan(ctx(sphbCloses, qualCloses, warm));
    const pos = positionFrom(strat.buildProposal(sig!, PROCEED));

    // Still stretched → hold.
    await strat.scan(ctx(sphbCloses, qualCloses, warm + 1));
    expect(strat.manage(pos, ctx(sphbCloses, qualCloses, warm + 1))).toBeNull();

    // Reverted → close.
    await strat.scan(ctx(sphbCloses, qualCloses, warm + 2));
    const action = strat.manage(pos, ctx(sphbCloses, qualCloses, warm + 2));
    expect(action?.kind).toBe("close");
    expect(action?.reason).toMatch(/revert/i);
  });
});

describe("QualSphbStrategy — 2-year weekly replay", () => {
  const P = DEFAULT_QUAL_SPHB_PARAMS;
  const WEEKS = 104; // 2 years of weekly bars

  // QUAL drifts gently up; SPHB oscillates on a 26-week cycle so the ratio
  // repeatedly stretches above the band and mean-reverts — several round trips.
  const qualCloses = Array.from({ length: WEEKS }, (_, i) => 100 + i * 0.1);
  const sphbCloses = Array.from({ length: WEEKS }, (_, i) => {
    const drift = 100 + i * 0.1; // track QUAL so the baseline ratio ≈ 1.0
    return drift * (1 + 0.15 * Math.sin((2 * Math.PI * i) / 26));
  });

  it("runs the full scan→manage loop with clean round trips", async () => {
    const strat = new QualSphbStrategy();
    const trips: Array<{ entryW: number; exitW: number; entry: number }> = [];
    let open: { w: number; pos: Position; entry: number } | null = null;
    let concurrentMax = 0;

    for (let w = P.smaWeeks; w < WEEKS; w += 1) {
      const c = ctx(sphbCloses, qualCloses, w);
      const signals = await strat.scan(c); // refreshes the sync-manage cache

      if (open) {
        concurrentMax = Math.max(concurrentMax, 1);
        const action = strat.manage(open.pos, c);
        if (action && action.kind === "close") {
          trips.push({ entryW: open.w, exitW: w, entry: open.entry });
          open = null;
        }
      } else if (signals.length > 0) {
        const draft = strat.buildProposal(signals[0]!, PROCEED);
        // Every entry must be a genuine stretch above the band.
        const view = ratioView(
          sphbCloses.slice(0, w + 1).map((cl, i) => bar("SPHB", cl, i)),
          qualCloses.slice(0, w + 1).map((cl, i) => bar("QUAL", cl, i)),
          P.smaWeeks,
        );
        expect(view).not.toBeNull();
        expect(view!.ratio).toBeGreaterThanOrEqual(
          view!.sma * (1 + P.entryBand),
        );
        open = { w, pos: positionFrom(draft), entry: draft.entry };
      }
    }

    // Multiple round trips over two years.
    expect(trips.length).toBeGreaterThanOrEqual(2);
    // Never more than one position open at a time.
    expect(concurrentMax).toBeLessThanOrEqual(1);
    // Every completed trip exits strictly after it entered.
    for (const t of trips) expect(t.exitW).toBeGreaterThan(t.entryW);
  });
});
