/**
 * Strategy #5 — Snapback (intraday, spec §3, T3.2).
 *
 * Thesis: a small-cap ($300M–$2B) that gaps down ≥10% on **no real fundamental
 * news** tends to snap back off the lows. The edge is entirely in the news gate:
 * if the drop is a genuine earnings miss, a dilution/offering, or a lawsuit/SEC
 * action, there is no snapback — so the LLM check is the highest-stakes call in
 * the whole system and is logged verbosely. Only technical/sympathy selloffs
 * qualify.
 *
 * Mechanics (all intraday, flat by the close):
 *   - pre-market screen for the gappers ({@link PremarketScreener});
 *   - after a 30–60 min wait, enter on a higher-low + opening-range-low reclaim
 *     with rising volume ({@link detectSnapbackReclaim});
 *   - stop below the day low; target a half gap-fill toward the prior close;
 *   - **forced flatten before the close** — enforced two ways: a broker-side
 *     time condition documented in the exit plan, and an app-side `manage`
 *     that returns a `close` once the flatten cutoff passes.
 *
 * Runs `AUTO` with tight caps (speed matters intraday). Deterministic under test:
 * the screener and candles are injected/pure, and the flatten cutoff is a pure
 * function of the clock.
 *
 * ## Sync-manage contract
 * `manage` is synchronous but the forced-flatten decision only needs the clock,
 * so no candle caching is required — `scan` just records the per-ticker day low
 * for reference/journaling.
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
  StaticPremarketScreener,
  gapDownPct,
  type PremarketScreener,
} from "./premarket-screener.js";
import {
  detectSnapbackReclaim,
  DEFAULT_RECLAIM_PARAMS,
  type ReclaimParams,
} from "./reclaim-detector.js";

/** Tunable parameters (defaults from the spec). */
export interface SnapbackParams extends ReclaimParams {
  /** Intraday candle timeframe key stored in `candles.timeframe`. */
  candleTimeframe: string;
  /** How many intraday bars to pull for the session. */
  lookbackBars: number;
  /** Stop cushion below the day low, as a fraction. */
  dayLowBufferPct: number;
  /** Fraction of the gap to target filling (spec: half gap-fill). */
  gapFillFraction: number;
  /** Session close as minutes-from-UTC-midnight (default 20:00 UTC ≈ US close). */
  closeMinutesUtc: number;
  /** Flatten this many minutes before the close (forced-flatten lead). */
  flattenLeadMinutes: number;
}

export const DEFAULT_SNAPBACK_PARAMS: SnapbackParams = Object.freeze({
  ...DEFAULT_RECLAIM_PARAMS,
  candleTimeframe: "5m",
  lookbackBars: 96,
  dayLowBufferPct: 0.01,
  gapFillFraction: 0.5,
  closeMinutesUtc: 20 * 60,
  flattenLeadMinutes: 10,
});

/** Minutes-from-midnight UTC for a timestamp. */
export function minutesOfDayUtc(at: Date): number {
  return at.getUTCHours() * 60 + at.getUTCMinutes();
}

/**
 * Whether an intraday position must be force-flattened now: true once the clock
 * reaches `closeMinutesUtc − flattenLeadMinutes`. Pure, so the cutoff is tested
 * directly. (A single session per day is assumed; overnight gaps are excluded by
 * the strategy never holding past this cutoff.)
 */
export function shouldForceFlatten(now: Date, params: SnapbackParams): boolean {
  const cutoff = params.closeMinutesUtc - params.flattenLeadMinutes;
  return minutesOfDayUtc(now) >= cutoff;
}

/** Per-ticker state recorded by `scan` (day low), for reference/journaling. */
interface SnapbackView {
  readonly dayLow: number;
}

export class SnapbackStrategy implements Strategy {
  readonly id = "snapback";
  readonly name = "Snapback";
  readonly timeframe: StrategyTimeframe = "intraday";
  readonly defaultMode: Mode = "AUTO";
  readonly riskParams: RiskParams;
  readonly meta: StrategyMeta = {
    summary:
      "Bets that a small company whose stock gaps down 10% or more on no real bad " +
      "news tends to bounce back off the lows the same day. The entire edge is the " +
      "news check: if the drop is a real problem, there is no bounce. Every trade " +
      "is closed before the market closes.",
    mechanic: {
      trigger: [
        "A small-cap ($300M–$2B) gaps down 10% or more before the open",
        "After a 30–60 minute wait, price makes a higher low and reclaims the opening-range low on rising volume",
      ],
      exitPlan: [
        "Stop below the day's low",
        "Target a half fill-back of the gap toward the prior close",
        "Force-flatten before the closing bell — never held overnight",
      ],
      llmRole:
        "Claude confirms the gap is a technical or sympathy selloff, not a real earnings miss, dilution, or lawsuit — the highest-stakes check in the system.",
      dataNeeds: "Pre-market gap screener and intraday candles (not yet wired)",
    },
    dataReady: false,
  };

  private readonly params: SnapbackParams;
  private readonly screener: PremarketScreener;
  private readonly views = new Map<Ticker, SnapbackView>();

  constructor(
    screener: PremarketScreener = new StaticPremarketScreener(),
    params: Partial<SnapbackParams> = {},
    riskParams: RiskParams = DEFAULT_RISK_PARAMS,
  ) {
    this.screener = screener;
    this.params = { ...DEFAULT_SNAPBACK_PARAMS, ...params };
    this.riskParams = riskParams;
  }

  async universe(ctx: MarketContext): Promise<Ticker[]> {
    const gappers = await this.screener.gappers(ctx.now);
    return gappers.map((g) => g.ticker);
  }

  async scan(ctx: MarketContext): Promise<QuantSignal[]> {
    const gappers = await this.screener.gappers(ctx.now);
    this.views.clear();

    const signals: QuantSignal[] = [];
    for (const gapper of gappers) {
      const candles = await ctx.candles(
        gapper.ticker,
        this.params.candleTimeframe,
        this.params.lookbackBars,
      );
      const setup = detectSnapbackReclaim(candles, ctx.now, this.params);
      if (!setup) continue;

      this.views.set(gapper.ticker, { dayLow: setup.dayLow });

      signals.push({
        strategyId: this.id,
        ticker: gapper.ticker,
        trigger: {
          kind: "snapback-reclaim",
          gapDownPct: gapDownPct(gapper),
          prevClose: gapper.prevClose,
          openingRangeLow: setup.openingRangeLow,
          higherLow: setup.higherLow,
          note: "Small-cap gap-down reclaimed the opening-range low on a higher low with rising volume — snapback if there is no real bad news",
        },
        quantMetrics: {
          reclaimPrice: setup.reclaimPrice,
          openingRangeLow: setup.openingRangeLow,
          dayLow: setup.dayLow,
          higherLow: setup.higherLow,
          volumeRatio: setup.volumeRatio,
          gapDownPct: gapDownPct(gapper),
          prevClose: gapper.prevClose,
          elapsedMinutes: setup.elapsedMinutes,
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
        `${signal.ticker} is a small-cap that gapped down ` +
        `${pct(signal.quantMetrics.gapDownPct)} today and has just reclaimed its ` +
        "opening-range low on a higher low with rising volume. This is the " +
        "highest-stakes check in the system: a snapback ONLY works when the drop " +
        "is technical / sympathy / no-news. Search today's news thoroughly. If " +
        "there is a genuine earnings miss, a capital raise or dilution/offering, a " +
        "lawsuit, an SEC action, a guidance cut, or any real fundamental bad news, " +
        "you MUST veto. Answer proceed only if you can find NO material negative " +
        "catalyst behind the drop.",
      context: {
        gapDownPct: signal.quantMetrics.gapDownPct,
        prevClose: signal.quantMetrics.prevClose,
        reclaimPrice: signal.quantMetrics.reclaimPrice,
        dayLow: signal.quantMetrics.dayLow,
      },
      requiredChecks: [
        "No earnings miss or guidance cut today",
        "No dilution, secondary offering, or capital raise announced",
        "No lawsuit, SEC/DOJ action, or fraud allegation",
        "The drop is explainable as technical/sector/sympathy, not fundamental",
      ],
      webSearch: true,
    };
  }

  buildProposal(signal: QuantSignal, _analysis: LLMAnalysis): ProposalDraft {
    const reclaim = numericMetric(signal.quantMetrics.reclaimPrice);
    const dayLow = numericMetric(signal.quantMetrics.dayLow);
    const prevClose = numericMetric(signal.quantMetrics.prevClose);
    if (reclaim === null || dayLow === null || prevClose === null) {
      throw new Error("snapback.buildProposal: missing reclaim/dayLow metrics");
    }
    const entry = round2(reclaim);
    const stop = round2(dayLow * (1 - this.params.dayLowBufferPct));
    // Half gap-fill: cover part of the distance from the entry back to the
    // prior close (the gap the stock fell from).
    const target = round2(
      entry + (prevClose - entry) * this.params.gapFillFraction,
    );
    return {
      strategyId: this.id,
      signalId: signal.id,
      ticker: signal.ticker,
      side: "long",
      requestedQty: 100,
      entry,
      stop,
      target,
      exitPlan: {
        stopLoss: stop,
        takeProfit: target,
        timeStop: { flatByClose: true },
        rules: [
          "Intraday only — NO overnight hold under any circumstance",
          "Forced flatten before the close (broker-side time-in-force + app-side manage())",
          "Hard stop below the session low; invalidated if the day low breaks",
          "Target a half gap-fill toward the prior close",
        ],
        notes:
          "Snapback off a no-news gap-down. Flat by close is mandatory; the LLM news veto is the primary risk control.",
      },
    };
  }

  manage(_position: Position, ctx: MarketContext): ExitAction | null {
    // App-side forced flatten: the broker time condition is the first line of
    // defense, this is the belt-and-suspenders enforcement in the money path.
    if (shouldForceFlatten(ctx.now, this.params)) {
      return {
        kind: "close",
        reason: "Forced intraday flatten before the close (snapback #5)",
      };
    }
    return null;
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
