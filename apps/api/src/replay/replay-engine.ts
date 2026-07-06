/**
 * The replay engine (T3.1) — feed historical candles through the *live* pipeline
 * so a strategy behaves in backtest exactly as it would in production.
 *
 * The engine owns only orchestration; it never touches the money path directly.
 * Each collaborator is a small structural port so the driver is unit-testable
 * with fakes (no DB, no Nest DI):
 *
 *   - {@link SettableClock} — the pipeline's `Clock`, advanced to each bar's ts
 *     so every point-in-time read sees simulated time (bound to `ReplayClock`).
 *   - {@link ReplayFeed} — receives bars so execution can fill/monitor brackets
 *     against them (the `Simulator`).
 *   - {@link ReplayPipeline} — the three money-path steps the engine drives
 *     (satisfied structurally by `PipelineService`).
 *   - {@link ReplayBarSource} — chronological historical bars for the window.
 *   - {@link ReplayPacer} — sleeps between ticks to honour the speed multiplier
 *     (real time in prod, a no-op in tests).
 *
 * **Determinism (AC1):** bars are sorted by `(ts, ticker)` and grouped into
 * ticks deterministically; the clock, analyst stub, and simulator are all
 * clock-free/RNG-free, so replaying a window twice yields identical trades.
 *
 * **Throughput (AC2):** wall-clock is dominated by the pacer's sleeps, which the
 * speed multiplier compresses ({@link pacingDelayMs}); at high speed an intraday
 * session replays in well under a minute.
 */
import { Logger } from "@nestjs/common";
import type { Candle } from "@magpie/core";

/** A clock the engine can advance to each simulated timestamp. */
export interface SettableClock {
  set(at: Date): void;
}

/** Receives each historical bar (execution fills/monitors against it). */
export interface ReplayFeed {
  onBar(bar: Candle): void;
}

/** The money-path steps the engine drives once per tick, in order. */
export interface ReplayPipeline {
  monitorPositions(strategyId: string): Promise<unknown>;
  runScan(strategyId: string): Promise<unknown>;
  sweepExpiredProposals(): Promise<unknown>;
}

/** Supplies historical bars for a window (any order; the engine sorts). */
export interface ReplayBarSource {
  bars(from: Date, to: Date): Promise<readonly Candle[]>;
}

/** Sleeps `ms` of wall-clock — real in prod, a no-op in tests. */
export interface ReplayPacer {
  wait(ms: number): Promise<void>;
}

/** What to replay. */
export interface ReplayRequest {
  readonly strategyId: string;
  readonly from: Date;
  readonly to: Date;
  /** Playback speed vs real time (1 = real, 60 = 60×). Clamped to ≥ 1. */
  readonly speed: number;
}

/** Summary of a completed replay run. */
export interface ReplayResult {
  readonly strategyId: string;
  readonly from: Date;
  readonly to: Date;
  readonly speed: number;
  /** Distinct timestamps stepped through. */
  readonly ticks: number;
  /** Total bars fed to the feed. */
  readonly barsProcessed: number;
  /** ISO timestamps of each tick, in order (determinism fingerprint). */
  readonly tickTimestamps: readonly string[];
}

/**
 * Simulated wall-clock delay between two adjacent ticks at a given speed:
 * `(nextTs − prevTs) / speed`, never negative. At speed 60 a 5-minute bar gap
 * becomes a 5 s pause; "max speed" is just a very large multiplier → ~0.
 */
export function pacingDelayMs(
  prevTs: Date,
  nextTs: Date,
  speed: number,
): number {
  const gap = nextTs.getTime() - prevTs.getTime();
  if (gap <= 0) return 0;
  return gap / Math.max(1, speed);
}

/** A pacer that actually sleeps (production). */
export class RealTimePacer implements ReplayPacer {
  async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

/** A pacer that never sleeps — for tests and "as fast as possible" runs. */
export class NoopPacer implements ReplayPacer {
  async wait(): Promise<void> {
    // Intentionally instant.
  }
}

/** One simulated instant and every bar stamped at it. */
interface Tick {
  readonly ts: Date;
  readonly bars: readonly Candle[];
}

/**
 * Deterministic total order over bars: by timestamp, then ticker as a stable
 * tie-break so same-instant bars are always fed in the same sequence.
 */
function compareBars(a: Candle, b: Candle): number {
  const dt = a.ts.getTime() - b.ts.getTime();
  if (dt !== 0) return dt;
  return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
}

/** Group an already-sorted bar list into per-timestamp ticks. */
function groupIntoTicks(sorted: readonly Candle[]): Tick[] {
  const ticks: Tick[] = [];
  let current: { ts: Date; bars: Candle[] } | null = null;
  for (const bar of sorted) {
    if (!current || current.ts.getTime() !== bar.ts.getTime()) {
      current = { ts: bar.ts, bars: [bar] };
      ticks.push(current);
    } else {
      current.bars.push(bar);
    }
  }
  return ticks;
}

export class ReplayEngine {
  private readonly logger = new Logger(ReplayEngine.name);

  constructor(
    private readonly clock: SettableClock,
    private readonly feed: ReplayFeed,
    private readonly pipeline: ReplayPipeline,
    private readonly source: ReplayBarSource,
    private readonly pacer: ReplayPacer = new RealTimePacer(),
  ) {}

  /**
   * Replay one strategy over a historical window. Steps chronologically through
   * every bar timestamp; at each tick it advances the clock, feeds the bars,
   * then runs monitor → scan → sweep (the live pipeline order), pacing between
   * ticks by the speed multiplier.
   */
  async run(request: ReplayRequest): Promise<ReplayResult> {
    const { strategyId, from, to, speed } = request;
    const raw = await this.source.bars(from, to);
    const sorted = [...raw].sort(compareBars);
    const ticks = groupIntoTicks(sorted);

    this.logger.log(
      `replay ${strategyId} ${from.toISOString()}..${to.toISOString()} ` +
        `at ${speed}× — ${sorted.length} bars over ${ticks.length} ticks`,
    );

    const tickTimestamps: string[] = [];
    let barsProcessed = 0;

    for (let i = 0; i < ticks.length; i++) {
      const tick = ticks[i]!;
      this.clock.set(tick.ts);
      for (const bar of tick.bars) {
        this.feed.onBar(bar);
        barsProcessed++;
      }

      // Monitor open positions against the fresh bar before hunting new entries,
      // then sweep expired proposals — the exact live-pipeline ordering.
      await this.pipeline.monitorPositions(strategyId);
      await this.pipeline.runScan(strategyId);
      await this.pipeline.sweepExpiredProposals();

      tickTimestamps.push(tick.ts.toISOString());

      const next = ticks[i + 1];
      if (next) {
        await this.pacer.wait(pacingDelayMs(tick.ts, next.ts, speed));
      }
    }

    return {
      strategyId,
      from,
      to,
      speed,
      ticks: ticks.length,
      barsProcessed,
      tickTimestamps,
    };
  }
}
