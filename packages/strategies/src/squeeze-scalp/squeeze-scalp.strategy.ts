/**
 * Strategy #4 — Squeeze scalp (intraday, spec §3 row 4, T3.3).
 *
 * Thesis: a heavily-shorted small-cap (>20% of float short) that breaks intraday
 * resistance on real catalyst news squeezes fast as shorts cover. The edge is
 * two-sided risk control:
 *   - the LLM must confirm the catalyst is **real news, not a pump** — a
 *     coordinated social ramp has no covering fuel and reverses violently;
 *   - a **chase guard** refuses any entry once the name is already up
 *     ≥30% on the day (the squeeze is largely spent).
 *
 * Mechanics (all intraday):
 *   - nightly short-interest ingest supplies the roster ({@link ShortInterestProvider});
 *   - enter on a resistance break confirmed by volume ({@link detectSqueezeBreakout});
 *   - **tight** stop (spec: 2–4%); scaled partial exits — bank half into the
 *     first push, run the rest to a larger target ({@link planScaleOut}).
 *
 * Runs `AUTO` with tight caps (speed matters). Deterministic under test: the
 * roster and candles are injected/pure, and the scale-out ladder is a pure
 * function of price and remaining quantity.
 *
 * ## Sync-manage contract
 * `manage` must be synchronous, so `scan` caches each roster name's latest price;
 * `manage` reads that cache to run the scale-out ladder without any async I/O.
 * (Monitor runs before scan in the pipeline, so the cache is one tick stale —
 * fine at intraday bar granularity.)
 */
import {
  type AnalysisRequest,
  type ExitAction,
  type LLMAnalysis,
  type MarketContext,
  type Mode,
  type Position,
  type ProposalDraft,
  type QuantSignal,
  type RiskParams,
  type StrategyTimeframe,
  type Strategy,
  type StrategyMeta,
  type Ticker,
  DEFAULT_RISK_PARAMS,
} from "@magpie/core";
import {
  StaticShortInterestProvider,
  type ShortInterestProvider,
} from "./short-interest.js";
import {
  detectSqueezeBreakout,
  planScaleOut,
  DEFAULT_SQUEEZE_PARAMS,
  DEFAULT_SCALE_OUT_PARAMS,
  type SqueezeParams,
  type ScaleOutParams,
} from "./squeeze-detector.js";

/** Tunable parameters (defaults from the spec). */
export interface SqueezeScalpParams extends SqueezeParams, ScaleOutParams {
  /** Intraday candle timeframe key stored in `candles.timeframe`. */
  candleTimeframe: string;
  /** How many intraday bars to pull for the session. */
  lookbackBars: number;
  /** Tight stop distance below entry, as a fraction (spec: 2–4%). */
  stopLossPct: number;
}

export const DEFAULT_SQUEEZE_SCALP_PARAMS: SqueezeScalpParams = Object.freeze({
  ...DEFAULT_SQUEEZE_PARAMS,
  ...DEFAULT_SCALE_OUT_PARAMS,
  candleTimeframe: "5m",
  lookbackBars: 96,
  stopLossPct: 0.03,
});

/** Standard scalp lot; the scale-out ladder is expressed against it. */
const ENTRY_QTY = 100;

/** Per-ticker state recorded by `scan` for the sync `manage` scale-out. */
interface SqueezeView {
  readonly lastPrice: number;
}

export class SqueezeScalpStrategy implements Strategy {
  readonly id = "squeeze-scalp";
  readonly name = "Squeeze Scalp";
  readonly timeframe: StrategyTimeframe = "intraday";
  readonly defaultMode: Mode = "AUTO";
  readonly riskParams: RiskParams;
  readonly meta: StrategyMeta = {
    summary:
      "Bets that a heavily shorted small-cap breaking out on real news squeezes " +
      "fast as trapped short-sellers rush to cover. It refuses to chase once the " +
      "move is largely spent, and manages risk with a tight stop and scaled exits.",
    mechanic: {
      trigger: [
        "The stock has more than 20% of its float sold short",
        "It breaks intraday resistance on a genuine news catalyst, confirmed by volume",
        "Chase guard: no entry if the stock is already up 30% or more on the day",
      ],
      exitPlan: [
        "Tight stop (roughly 2–4%)",
        "Bank half the position into the first push higher",
        "Run the rest toward a larger target",
      ],
      llmRole:
        "Claude confirms the catalyst is real news, not a coordinated social-media pump that would reverse violently.",
      dataNeeds:
        "Nightly short-interest roster and intraday candles (not yet wired)",
    },
    dataReady: false,
  };

  private readonly params: SqueezeScalpParams;
  private readonly shortInterest: ShortInterestProvider;
  private readonly views = new Map<Ticker, SqueezeView>();

  constructor(
    shortInterest: ShortInterestProvider = new StaticShortInterestProvider(),
    params: Partial<SqueezeScalpParams> = {},
    riskParams: RiskParams = DEFAULT_RISK_PARAMS,
  ) {
    this.shortInterest = shortInterest;
    this.params = { ...DEFAULT_SQUEEZE_SCALP_PARAMS, ...params };
    this.riskParams = riskParams;
  }

  async universe(ctx: MarketContext): Promise<Ticker[]> {
    const roster = await this.shortInterest.highShortInterest(ctx.now);
    return roster.map((d) => d.ticker);
  }

  async scan(ctx: MarketContext): Promise<QuantSignal[]> {
    const roster = await this.shortInterest.highShortInterest(ctx.now);
    this.views.clear();

    const signals: QuantSignal[] = [];
    for (const datum of roster) {
      const candles = await ctx.candles(
        datum.ticker,
        this.params.candleTimeframe,
        this.params.lookbackBars,
      );
      if (candles.length === 0) continue;

      // Cache the latest price for every roster name so an open position always
      // has a price for the sync scale-out ladder.
      this.views.set(datum.ticker, {
        lastPrice: candles[candles.length - 1]!.close,
      });

      const setup = detectSqueezeBreakout(candles, this.params);
      if (!setup) continue;

      signals.push({
        strategyId: this.id,
        ticker: datum.ticker,
        trigger: {
          kind: "squeeze-breakout",
          shortInterestPctFloat: datum.shortInterestPctFloat,
          resistance: setup.resistance,
          intradayGainPct: setup.intradayGainPct,
          note: "Heavily-shorted name broke intraday resistance on volume — squeeze if the catalyst is real news, not a pump",
        },
        quantMetrics: {
          breakoutPrice: setup.breakoutPrice,
          resistance: setup.resistance,
          volumeRatio: setup.volumeRatio,
          intradayGainPct: setup.intradayGainPct,
          shortInterestPctFloat: datum.shortInterestPctFloat,
        },
      });
    }
    return signals;
  }

  llmPrompt(signal: QuantSignal): AnalysisRequest {
    return {
      strategyId: this.id,
      ticker: signal.ticker,
      prompt:
        `${signal.ticker} is heavily shorted (` +
        `${pct(signal.quantMetrics.shortInterestPctFloat)} of float) and just broke ` +
        "intraday resistance on rising volume. The one thing that must be true for a " +
        "short squeeze is a REAL catalyst driving the covering. Search today's news. " +
        "Confirm there is genuine, verifiable news (earnings beat, a signed contract, " +
        "an FDA/regulatory approval, an analyst upgrade, an M&A report). If the move " +
        "looks like a coordinated pump / social-media ramp / low-float manipulation " +
        "with no hard catalyst, you MUST veto — a pump has no covering fuel and " +
        "reverses violently. Answer proceed only if the catalyst is real.",
      context: {
        shortInterestPctFloat: signal.quantMetrics.shortInterestPctFloat,
        breakoutPrice: signal.quantMetrics.breakoutPrice,
        resistance: signal.quantMetrics.resistance,
        intradayGainPct: signal.quantMetrics.intradayGainPct,
      },
      requiredChecks: [
        "There is genuine, verifiable catalyst news today (not a rumor)",
        "The move is not a coordinated pump or social-media ramp",
        "The breakout volume reflects real participation, not a single print",
      ],
      webSearch: true,
    };
  }

  buildProposal(signal: QuantSignal, _analysis: LLMAnalysis): ProposalDraft {
    const breakout = numericMetric(signal.quantMetrics.breakoutPrice);
    if (breakout === null) {
      throw new Error("squeeze-scalp.buildProposal: missing breakout price");
    }
    const entry = round2(breakout);
    const stop = round2(entry * (1 - this.params.stopLossPct));
    // Headline target is the runner rung; the first tranche banks earlier via
    // manage()'s scale-out ladder.
    const target = round2(entry * (1 + this.params.runnerGainPct));
    return {
      strategyId: this.id,
      signalId: signal.id,
      ticker: signal.ticker,
      side: "long",
      requestedQty: ENTRY_QTY,
      entry,
      stop,
      target,
      exitPlan: {
        stopLoss: stop,
        takeProfit: target,
        timeStop: { flatByClose: true },
        rules: [
          `Tight stop ${(this.params.stopLossPct * 100).toFixed(0)}% below entry — squeezes fail fast`,
          `Scale out ${(this.params.firstTrancheFraction * 100).toFixed(0)}% at +${(this.params.firstTrancheGainPct * 100).toFixed(0)}%, run the rest to +${(this.params.runnerGainPct * 100).toFixed(0)}%`,
          "Chase guard: no fresh entry once the name is already +30% on the day",
          "Intraday scalp — flat by close, do not carry a spent squeeze",
        ],
        notes:
          "Squeeze scalp on a real-catalyst breakout in a high-short-interest name. The LLM pump-vs-news veto is the primary risk control; exits are scaled to bank the fast move.",
      },
    };
  }

  manage(position: Position, _ctx: MarketContext): ExitAction | null {
    const view = this.views.get(position.ticker);
    if (!view) return null;

    const decision = planScaleOut(
      position.avgEntryPrice,
      ENTRY_QTY,
      position.qty,
      view.lastPrice,
      this.params,
    );
    switch (decision.action) {
      case "scale-out":
        return {
          kind: "scale-out",
          qty: decision.qty,
          reason: "Bank first tranche into squeeze strength (squeeze scalp #4)",
        };
      case "close":
        return {
          kind: "close",
          reason: "Runner target reached — exit the squeeze (squeeze scalp #4)",
        };
      case "hold":
        return null;
    }
  }
}

/** Read a numeric quant metric that may be undefined. */
function numericMetric(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Round to cents (prices cross the wire as 2dp). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Format a fraction as a percent string for the prompt. */
function pct(value: number | undefined): string {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "n/a";
}
