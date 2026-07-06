import { describe, it, expect } from "vitest";
import { Simulator, type Candle } from "@magpie/core";
import { ReplayClock } from "./replay-clock.js";
import {
  NoopPacer,
  pacingDelayMs,
  ReplayEngine,
  type ReplayBarSource,
  type ReplayFeed,
  type ReplayPipeline,
} from "./replay-engine.js";

const SESSION_OPEN = Date.parse("2024-03-04T14:30:00.000Z"); // 09:30 ET
const FIVE_MIN = 5 * 60_000;

/** Build a flat-ish 5-minute bar series for one ticker, `close[i]` per bar. */
function series(
  ticker: string,
  closes: number[],
  startMs = SESSION_OPEN,
): Candle[] {
  return closes.map((close, i) => ({
    ticker,
    timeframe: "5m" as const,
    ts: new Date(startMs + i * FIVE_MIN),
    open: close - 0.1,
    high: close + 0.2,
    low: close - 0.2,
    close,
    volume: 1_000,
  }));
}

/** A bar source that just replays a fixed list. */
class FixedSource implements ReplayBarSource {
  constructor(private readonly all: Candle[]) {}
  async bars(): Promise<readonly Candle[]> {
    return this.all;
  }
}

/**
 * A tiny deterministic "strategy" wired as a ReplayPipeline: the first time a
 * ticker's close crosses `trigger`, it places a market bracket on the sim. It
 * also records the money-path call order for assertions. Feed bars to it via
 * `observe` (the engine feeds the sim; the test composes both).
 */
class BreakoutPipeline implements ReplayPipeline {
  readonly calls: string[] = [];
  private readonly latest = new Map<string, Candle>();
  private readonly placed = new Set<string>();

  constructor(
    private readonly sim: Simulator,
    private readonly trigger: number,
  ) {}

  observe(bar: Candle): void {
    this.latest.set(bar.ticker, bar);
  }

  async monitorPositions(strategyId: string): Promise<number> {
    this.calls.push(`monitor:${strategyId}`);
    return 0;
  }

  async runScan(strategyId: string): Promise<number> {
    this.calls.push(`scan:${strategyId}`);
    for (const [ticker, bar] of this.latest) {
      if (this.placed.has(ticker)) continue;
      if (bar.close >= this.trigger) {
        this.placed.add(ticker);
        await this.sim.placeBracket({
          strategyId,
          target: "SIM",
          ticker,
          side: "long",
          qty: 10,
          entryType: "market",
          stopPrice: Number((bar.close * 0.97).toFixed(2)),
          targetPrice: Number((bar.close * 1.03).toFixed(2)),
        });
      }
    }
    return 0;
  }

  async sweepExpiredProposals(): Promise<number> {
    this.calls.push("sweep");
    return 0;
  }
}

/** Feed that drives both the simulator and the pipeline's bar cache. */
function compositeFeed(sim: Simulator, pipeline: BreakoutPipeline): ReplayFeed {
  return {
    onBar(bar: Candle): void {
      sim.onBar(bar);
      pipeline.observe(bar);
    },
  };
}

/** One full replay run over the fixture, returning the sim's fills. */
async function runOnce(bars: Candle[], trigger: number) {
  const clock = new ReplayClock(new Date(SESSION_OPEN));
  const sim = new Simulator();
  const pipeline = new BreakoutPipeline(sim, trigger);
  const engine = new ReplayEngine(
    clock,
    compositeFeed(sim, pipeline),
    pipeline,
    new FixedSource(bars),
    new NoopPacer(),
  );
  const result = await engine.run({
    strategyId: "breakout",
    from: new Date(SESSION_OPEN),
    to: new Date(SESSION_OPEN + 100 * FIVE_MIN),
    speed: 60,
  });
  return { result, fills: await sim.getFills(), calls: pipeline.calls };
}

describe("pacingDelayMs", () => {
  it("compresses a bar gap by the speed multiplier", () => {
    const a = new Date(SESSION_OPEN);
    const b = new Date(SESSION_OPEN + FIVE_MIN);
    expect(pacingDelayMs(a, b, 1)).toBe(FIVE_MIN);
    expect(pacingDelayMs(a, b, 60)).toBe(FIVE_MIN / 60); // 5s
  });

  it("never returns a negative delay and floors speed at 1", () => {
    const a = new Date(SESSION_OPEN + FIVE_MIN);
    const b = new Date(SESSION_OPEN);
    expect(pacingDelayMs(a, b, 60)).toBe(0);
    expect(pacingDelayMs(new Date(0), new Date(1000), 0)).toBe(1000);
  });
});

describe("ReplayEngine — ordering & structure", () => {
  it("groups same-timestamp bars into one tick and drives monitor→scan→sweep in order", async () => {
    const bars = [...series("AAA", [100, 101]), ...series("BBB", [50, 51])];
    const { result, calls } = await runOnce(bars, 1_000_000); // never triggers
    expect(result.ticks).toBe(2); // two timestamps, two tickers each
    expect(result.barsProcessed).toBe(4);
    // Per tick: monitor, scan, sweep — twice.
    expect(calls).toEqual([
      "monitor:breakout",
      "scan:breakout",
      "sweep",
      "monitor:breakout",
      "scan:breakout",
      "sweep",
    ]);
  });

  it("steps ticks in chronological order regardless of input order", async () => {
    const late = series("AAA", [100], SESSION_OPEN + 2 * FIVE_MIN);
    const early = series("AAA", [99], SESSION_OPEN);
    const { result } = await runOnce([...late, ...early], 1_000_000);
    expect(result.tickTimestamps).toEqual([
      new Date(SESSION_OPEN).toISOString(),
      new Date(SESSION_OPEN + 2 * FIVE_MIN).toISOString(),
    ]);
  });
});

describe("ReplayEngine — AC1: deterministic trades", () => {
  it("replays the same session twice and produces identical fills", async () => {
    // AAA breaks out (crosses 105) and later hits its target; BBB never does.
    const bars = [
      ...series("AAA", [102, 104, 106, 108, 110, 112]),
      ...series("BBB", [40, 40, 40, 40, 40, 40]),
    ];
    const first = await runOnce(bars, 105);
    const second = await runOnce(bars, 105);

    // The strategy actually traded (entry + at least the target exit).
    expect(first.fills.length).toBeGreaterThan(0);
    expect(first.fills.every((f) => f.ticker === "AAA")).toBe(true);

    // Byte-identical fills across the two runs — the T3.1 determinism AC.
    expect(JSON.stringify(second.fills)).toBe(JSON.stringify(first.fills));
  });
});

describe("ReplayEngine — AC2: throughput", () => {
  it("replays a full intraday session in well under a minute at 60×", async () => {
    // 78 five-minute bars ≈ a 6.5h RTH session, for two tickers.
    const closes = Array.from({ length: 78 }, (_, i) => 100 + (i % 7));
    const bars = [...series("AAA", closes), ...series("BBB", closes)];

    const start = process.hrtime.bigint();
    const { result } = await runOnce(bars, 104);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(result.ticks).toBe(78);
    expect(result.barsProcessed).toBe(156);
    // NoopPacer removes simulated sleeps; this asserts the engine's compute
    // throughput clears the one-minute bar with enormous margin.
    expect(elapsedMs).toBeLessThan(60_000);
  });
});
