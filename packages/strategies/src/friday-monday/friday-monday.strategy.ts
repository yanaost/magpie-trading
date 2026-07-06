/**
 * Strategy #7 — Friday→Monday flow (spec §3, T2.7).
 *
 * Thesis: names that retail is crowding into and that close near their weekly
 * high on Friday tend to gap and run early the next week as the weekend flow
 * hits. We scan the Friday trending / most-bought list for strong weekly-high
 * closes and set a buy-stop just above Friday's high, so Monday must *confirm*
 * strength to fill. If Monday instead opens weak the trade auto-cancels; a
 * filled trade is sold into mid-week strength and never held over a second
 * weekend.
 *
 * Weekly cadence, but it acts on daily bars around the weekend boundary. Week
 * boundaries come from an injected {@link TradingCalendar} (holiday/half-day
 * aware); the trending list from an injected {@link TrendingListProvider}. Both
 * have static defaults so the strategy is deterministic offline.
 *
 * ## Sync-manage contract
 * `scan` runs every pipeline cycle and always refreshes a per-ticker
 * {@link FlowView} (today's bar + week-boundary flags + the prior Friday close)
 * so `manage` — which fires on the Monday-open and mid-week sessions, not just
 * Fridays — can read it synchronously. Signals are only *emitted* on the
 * week-close session.
 */
import {
  type AnalysisRequest,
  type Candle,
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
import { TradingCalendar } from "./trading-week.js";
import {
  StaticTrendingListProvider,
  type TrendingListProvider,
} from "./trending-list.js";
import {
  detectWeeklyHighClose,
  flowExitDecision,
  DEFAULT_FRIDAY_MONDAY_PARAMS,
  type FridayMondayParams,
  type FlowView,
} from "./flow-detector.js";

export class FridayMondayFlowStrategy implements Strategy {
  readonly id = "friday-monday-flow";
  readonly name = "Friday→Monday Flow";
  readonly timeframe: StrategyTimeframe = "weekly";
  readonly defaultMode: Mode = "APPROVE";
  readonly riskParams: RiskParams;

  private readonly params: FridayMondayParams;
  private readonly trending: TrendingListProvider;
  private readonly calendar: TradingCalendar;
  /** Per-ticker snapshot from the latest scan, for sync `manage`. */
  private readonly views = new Map<Ticker, FlowView>();

  constructor(
    trending: TrendingListProvider = new StaticTrendingListProvider(),
    calendar: TradingCalendar = new TradingCalendar(),
    params: Partial<FridayMondayParams> = {},
    riskParams: RiskParams = DEFAULT_RISK_PARAMS,
  ) {
    this.trending = trending;
    this.calendar = calendar;
    this.params = { ...DEFAULT_FRIDAY_MONDAY_PARAMS, ...params };
    this.riskParams = riskParams;
  }

  async universe(ctx: MarketContext): Promise<Ticker[]> {
    return [...new Set(await this.trending.trending(ctx.now))];
  }

  async scan(ctx: MarketContext): Promise<QuantSignal[]> {
    const tickers = await this.universe(ctx);
    this.views.clear();

    const isWeekClose = this.calendar.isWeekCloseSession(ctx.now);
    const isWeekOpen = this.calendar.isWeekOpenSession(ctx.now);

    const signals: QuantSignal[] = [];
    for (const ticker of tickers) {
      const candles = await ctx.candles(
        ticker,
        this.params.candleTimeframe,
        this.params.lookbackBars,
      );
      if (candles.length === 0) continue;
      const last = candles[candles.length - 1]!;

      // Always refresh the sync-manage view (held positions read it any session).
      this.views.set(ticker, {
        asOf: ctx.now,
        todayOpen: last.open,
        todayHigh: last.high,
        todayClose: last.close,
        isWeekOpen,
        isWeekClose,
        priorWeekClose: this.priorWeekClose(candles),
      });

      // Only *emit* entry signals on the week-close (Friday) session.
      if (!isWeekClose) continue;
      const setup = detectWeeklyHighClose(candles, this.params);
      if (!setup) continue;

      signals.push({
        strategyId: this.id,
        ticker,
        trigger: {
          kind: "weekly-high-close",
          weekHigh: setup.weekHigh,
          belowHighPct: setup.belowHighPct,
          note: "Closed near the weekly high on the trending list — weekend flow setup",
        },
        quantMetrics: {
          fridayClose: setup.fridayClose,
          fridayHigh: setup.fridayHigh,
          weekHigh: setup.weekHigh,
          belowHighPct: setup.belowHighPct,
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
        `${signal.ticker} is on the trending/most-bought list and closed near its ` +
        "weekly high into the weekend — a Friday→Monday flow-continuation setup. " +
        "Verify the strength is driven by durable retail/momentum flow (not a " +
        "one-off headline about to fade or a pending weekend risk that could gap it " +
        "down). Answer proceed or veto only.",
      context: {
        fridayClose: signal.quantMetrics.fridayClose,
        weekHigh: signal.quantMetrics.weekHigh,
        belowHighPct: signal.quantMetrics.belowHighPct,
      },
      requiredChecks: [
        "Strength reflects durable flow, not a single fading headline",
        "No known weekend/binary risk likely to gap the name down Monday",
      ],
      webSearch: true,
    };
  }

  buildProposal(signal: QuantSignal, _analysis: LLMAnalysis): ProposalDraft {
    const fridayClose = numberOr(signal.quantMetrics.fridayClose, NaN);
    const fridayHigh = numberOr(signal.quantMetrics.fridayHigh, NaN);
    if (!Number.isFinite(fridayClose) || !Number.isFinite(fridayHigh)) {
      throw new Error("friday-monday.buildProposal: missing Friday metrics");
    }
    // Buy-stop just above Friday's high: Monday must confirm strength to fill,
    // so a weak Monday never triggers the entry (the pre-fill auto-cancel).
    const entry = round2(fridayHigh * (1 + this.params.entryBufferPct));
    const stop = round2(fridayClose * (1 - this.params.stopPct));
    const target = round2(fridayClose * (1 + this.params.targetPct));
    const tp = (this.params.targetPct * 100).toFixed(0);
    const weak = (this.params.weakOpenPct * 100).toFixed(0);
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
        rules: [
          `Buy-stop entry above Friday's high — a weak Monday never fills (auto-cancel)`,
          `Flatten if Monday opens more than ${weak}% below Friday's close`,
          `Exit mid-week into strength at +${tp}%`,
          "End-of-week time stop — never hold over a second weekend",
        ],
        notes:
          "Weekend-flow continuation; short-lived by design, entry confirmed by Monday strength.",
      },
    };
  }

  manage(position: Position, _ctx: MarketContext): ExitAction | null {
    const view = this.views.get(position.ticker);
    if (!view) return null;
    return flowExitDecision(view, this.params);
  }

  /** Close of the most recent prior week-close session in the series, or null. */
  private priorWeekClose(candles: Candle[]): number | null {
    // Walk back from the second-to-last bar for the latest week-close session.
    for (let i = candles.length - 2; i >= 0; i--) {
      if (this.calendar.isWeekCloseSession(candles[i]!.ts)) {
        return candles[i]!.close;
      }
    }
    return null;
  }
}

/** Read a numeric metric that may be undefined, with a fallback. */
function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Round to cents (prices cross the wire as 2dp). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
