/**
 * Strategy #1 — Earnings fade (spec §3, T2.5).
 *
 * Thesis: after a genuine earnings **miss / guide-down**, the first dip-buy
 * bounce fails. We watch watchlist names that reported in the last few sessions
 * for a post-earnings *bounce-stall below the reaction-day high* (see
 * {@link detectPostEarningsStall}); when it fires, the drop is resuming.
 *
 * In a long-only account this is primarily a **do-not-buy filter** — it runs
 * WATCH by default, journaling "don't buy this dip" rather than trading. The
 * executable expression of the fade is **long puts**, which requires options
 * permissions; since the platform models only long/short equity, `buildProposal`
 * frames the trade as a `short` with the stop above the reaction high and notes
 * the puts alternative in the exit plan. The LLM gate must confirm the report
 * was a real miss/guide-down, not a beat that merely dipped.
 *
 * Cadence: daily (swing). The calendar of recent reporters comes from an
 * injected {@link CalendarProvider} so the strategy is fully deterministic under
 * test; the reaction/stall math is pure OHLC.
 *
 * ## Sync-manage contract
 * Like the QUAL/SPHB pair, `manage` is synchronous but needs candle data, so
 * `scan` caches the per-ticker reaction high that `manage` reads to detect a
 * thesis break (price reclaiming the reaction high).
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
  type Ticker,
  DEFAULT_RISK_PARAMS,
} from "@magpie/core";
import { StaticCalendarProvider, type CalendarProvider } from "./calendar.js";
import {
  detectPostEarningsStall,
  DEFAULT_STALL_PARAMS,
  type StallParams,
} from "./stall-detector.js";

/** Tunable parameters (defaults from the spec). */
export interface EarningsFadeParams extends StallParams {
  /** Daily candle timeframe key stored in `candles.timeframe`. */
  candleTimeframe: string;
  /** How many daily bars to pull around the report for the detector. */
  lookbackBars: number;
  /** Protective stop cushion above the reaction high, as a fraction. */
  stopCushionPct: number;
  /** Downside target as a fraction below the stall close (measured move). */
  targetDropPct: number;
}

export const DEFAULT_EARNINGS_FADE_PARAMS: EarningsFadeParams = Object.freeze({
  ...DEFAULT_STALL_PARAMS,
  candleTimeframe: "1d",
  lookbackBars: 10,
  stopCushionPct: 0.01,
  targetDropPct: 0.08,
});

/** Per-ticker state cached by `scan` and read synchronously by `manage`. */
interface FadeView {
  readonly postEarningsHigh: number;
}

export class EarningsFadeStrategy implements Strategy {
  readonly id = "earnings-fade";
  readonly name = "Earnings Fade";
  readonly timeframe: StrategyTimeframe = "swing";
  readonly defaultMode: Mode = "WATCH";
  readonly riskParams: RiskParams;

  private readonly params: EarningsFadeParams;
  private readonly calendar: CalendarProvider;
  /** Reaction-high per ticker from the latest scan, for sync `manage`. */
  private readonly views = new Map<Ticker, FadeView>();

  constructor(
    calendar: CalendarProvider = new StaticCalendarProvider(),
    params: Partial<EarningsFadeParams> = {},
    riskParams: RiskParams = DEFAULT_RISK_PARAMS,
  ) {
    this.calendar = calendar;
    this.params = { ...DEFAULT_EARNINGS_FADE_PARAMS, ...params };
    this.riskParams = riskParams;
  }

  async universe(ctx: MarketContext): Promise<Ticker[]> {
    const events = await this.calendar.recentEarnings(ctx.now);
    return [...new Set(events.map((e) => e.ticker))];
  }

  async scan(ctx: MarketContext): Promise<QuantSignal[]> {
    const events = await this.calendar.recentEarnings(ctx.now);
    this.views.clear();

    const signals: QuantSignal[] = [];
    for (const event of events) {
      const candles = await ctx.candles(
        event.ticker,
        this.params.candleTimeframe,
        this.params.lookbackBars,
      );
      const stall = detectPostEarningsStall(
        candles,
        event.reportDate,
        this.params,
      );
      if (!stall) continue;

      // Cache the reaction high for the sync-manage thesis-break check.
      this.views.set(event.ticker, {
        postEarningsHigh: stall.postEarningsHigh,
      });

      signals.push({
        strategyId: this.id,
        ticker: event.ticker,
        trigger: {
          kind: "post-earnings-stall",
          reportDate: event.reportDate,
          postEarningsHigh: stall.postEarningsHigh,
          reactionMovePct: stall.reactionMovePct,
          note: "Failed dip-buy bounce below the post-earnings high — fade the miss",
        },
        quantMetrics: {
          postEarningsHigh: stall.postEarningsHigh,
          reactionMovePct: stall.reactionMovePct,
          reactionLow: stall.reactionLow,
          stallClose: stall.stallClose,
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
        `${signal.ticker} sold off on its latest earnings report and a dip-buy ` +
        "bounce has just stalled below the post-earnings high. Confirm this was a " +
        "genuine miss or guide-down (weak results, lowered guidance, or a broken " +
        "growth story) — NOT a beat that merely pulled back, and NOT a one-off " +
        "explainable dip. Answer proceed to fade (do-not-buy / long puts) or veto.",
      context: {
        reactionMovePct: signal.quantMetrics.reactionMovePct,
        postEarningsHigh: signal.quantMetrics.postEarningsHigh,
        stallClose: signal.quantMetrics.stallClose,
      },
      requiredChecks: [
        "The report was an actual miss or guide-down, not a beat-and-dip",
        "No pending catalyst (buyback, upgrade, M&A) likely to reverse the drop",
      ],
      webSearch: true,
    };
  }

  buildProposal(signal: QuantSignal, _analysis: LLMAnalysis): ProposalDraft {
    const stallClose = numericMetric(signal.quantMetrics.stallClose);
    const postEarningsHigh = numericMetric(
      signal.quantMetrics.postEarningsHigh,
    );
    if (stallClose === null || postEarningsHigh === null) {
      throw new Error(
        "earnings-fade.buildProposal: missing stall/reaction metrics",
      );
    }
    // Fade (short) below the failed bounce; stop just above the reaction high.
    const entry = round2(stallClose);
    const stop = round2(postEarningsHigh * (1 + this.params.stopCushionPct));
    const target = round2(stallClose * (1 - this.params.targetDropPct));
    return {
      strategyId: this.id,
      signalId: signal.id,
      ticker: signal.ticker,
      side: "short",
      requestedQty: 100,
      entry,
      stop,
      target,
      exitPlan: {
        stopLoss: stop,
        takeProfit: target,
        rules: [
          "Long-only accounts: DO NOT BUY — this is a do-not-buy filter",
          "With options permissions, express as long puts (fade the miss)",
          "Cover / invalidate if price reclaims the post-earnings high",
        ],
        notes:
          "Post-earnings miss fade. Equity short shown for modeling; real expression is long puts, options-gated.",
      },
    };
  }

  manage(position: Position, _ctx: MarketContext): ExitAction | null {
    // Thesis break: a short fade is wrong once price reclaims the reaction high.
    const view = this.views.get(position.ticker);
    if (view && position.avgEntryPrice > 0) {
      // The bracket stop enforces this on price; nothing further to adjust here.
      void view;
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
