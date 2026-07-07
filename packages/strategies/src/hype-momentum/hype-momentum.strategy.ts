/**
 * Strategy #2 — Hype momentum (spec §3, T2.6).
 *
 * Thesis: a name breaks out on a genuine catalyst with a volume spike (≥ a few
 * times its 20-day average) above resistance; ride the early momentum with
 * pre-written exits and get out fast when the move stalls — and always before
 * the next earnings print. The LLM gate confirms the catalyst is real and the
 * move is still early-stage (not already parabolic / late).
 *
 * Daily (swing) cadence. The candidate watchlist (trending / most-bought /
 * unusual-volume) comes from an injected {@link HypeCandidateProvider}; upcoming
 * earnings dates from an injected {@link EarningsSchedule}. Both have static
 * defaults so the strategy is inert and deterministic offline.
 *
 * ## Sync-manage contract
 * `manage` is synchronous but the stall/earnings/MA exits need candle data, so
 * `scan` caches a per-ticker {@link HypeView} (for *every* candidate it inspects,
 * not just those that signalled) which `manage` reads. Same pattern as QUAL/SPHB
 * and earnings-fade.
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
  StaticHypeCandidateProvider,
  StaticEarningsSchedule,
  type HypeCandidateProvider,
  type EarningsSchedule,
} from "./candidates.js";
import {
  detectHypeSpike,
  hypeExitDecision,
  closeMA,
  DEFAULT_HYPE_MOMENTUM_PARAMS,
  type HypeMomentumParams,
  type HypeView,
} from "./spike-detector.js";

export class HypeMomentumStrategy implements Strategy {
  readonly id = "hype-momentum";
  readonly name = "Hype Momentum";
  readonly timeframe: StrategyTimeframe = "swing";
  readonly defaultMode: Mode = "APPROVE";
  readonly riskParams: RiskParams;
  readonly meta: StrategyMeta = {
    summary:
      "Rides the early part of a breakout when a stock jumps on real news with " +
      "a big volume spike. The goal is to catch the fast first move and get out " +
      "quickly when it stalls — and always before the next earnings report.",
    mechanic: {
      trigger: [
        "The stock breaks above resistance on a volume spike well above its 20-day average",
        "There is a genuine catalyst behind the move (news, not just chatter)",
        "The next earnings date is far enough away to exit before it",
      ],
      exitPlan: [
        "Pre-written stop below the breakout level",
        "Exit fast when the move stalls or loses its moving-average support",
        "Always flat before the next earnings print",
      ],
      llmRole:
        "Claude confirms the catalyst is real and the move is still early-stage, not already parabolic and late.",
      dataNeeds:
        "Trending / most-bought list and earnings-date feeds (not yet wired)",
    },
    dataReady: false,
  };

  private readonly params: HypeMomentumParams;
  private readonly candidateProvider: HypeCandidateProvider;
  private readonly earnings: EarningsSchedule;
  /** Per-ticker snapshot from the latest scan, for sync `manage`. */
  private readonly views = new Map<Ticker, HypeView>();

  constructor(
    candidateProvider: HypeCandidateProvider = new StaticHypeCandidateProvider(),
    earnings: EarningsSchedule = new StaticEarningsSchedule(),
    params: Partial<HypeMomentumParams> = {},
    riskParams: RiskParams = DEFAULT_RISK_PARAMS,
  ) {
    this.candidateProvider = candidateProvider;
    this.earnings = earnings;
    this.params = { ...DEFAULT_HYPE_MOMENTUM_PARAMS, ...params };
    this.riskParams = riskParams;
  }

  async universe(ctx: MarketContext): Promise<Ticker[]> {
    return [...new Set(await this.candidateProvider.candidates(ctx.now))];
  }

  async scan(ctx: MarketContext): Promise<QuantSignal[]> {
    const tickers = await this.universe(ctx);
    this.views.clear();

    const signals: QuantSignal[] = [];
    for (const ticker of tickers) {
      const candles = await ctx.candles(
        ticker,
        this.params.candleTimeframe,
        this.params.lookbackBars,
      );
      if (candles.length < 2) continue;

      const last = candles[candles.length - 1]!;
      const prev = candles[candles.length - 2]!;
      const avg = trailingAvgVolume(candles, this.params.volAvgWindow);
      const maExit = closeMA(candles, this.params.maExitWindow);
      if (avg === null || maExit === null) continue;

      // Cache the view for sync-manage (held positions read this every cycle).
      this.views.set(ticker, {
        asOf: ctx.now,
        lastOpen: last.open,
        lastClose: last.close,
        lastHigh: last.high,
        lastVolume: last.volume,
        priorHigh: prev.high,
        avgVolume: avg,
        maExit,
        nextEarningsDate: this.earnings.nextEarningsDate(ticker, ctx.now),
      });

      const spike = detectHypeSpike(candles, this.params);
      if (!spike) continue;

      signals.push({
        strategyId: this.id,
        ticker,
        trigger: {
          kind: "volume-spike-breakout",
          resistance: spike.resistance,
          volMult: spike.volMult,
          note: "Volume-spike breakout above resistance — early momentum",
        },
        quantMetrics: {
          spikeClose: spike.spikeClose,
          volMult: spike.volMult,
          avgVolume: spike.avgVolume,
          resistance: spike.resistance,
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
        `${signal.ticker} just broke out above resistance on a volume spike ` +
        `(~${numberOr(signal.quantMetrics.volMult, 0).toFixed(1)}× its average). ` +
        "Confirm there is a REAL, fresh catalyst driving it (product, contract, " +
        "guidance, sector rotation) and that the move is still EARLY-STAGE — not " +
        "already parabolic / days into a blow-off with the news fully priced. " +
        "Answer proceed or veto only.",
      context: {
        volMult: signal.quantMetrics.volMult,
        resistance: signal.quantMetrics.resistance,
        spikeClose: signal.quantMetrics.spikeClose,
      },
      requiredChecks: [
        "There is a genuine, identifiable catalyst (not just price action)",
        "The move is early-stage, not a late/parabolic blow-off",
        "No earnings report due before the expected hold completes",
      ],
      webSearch: true,
    };
  }

  buildProposal(signal: QuantSignal, _analysis: LLMAnalysis): ProposalDraft {
    const entry = numberOr(signal.quantMetrics.spikeClose, NaN);
    if (!Number.isFinite(entry)) {
      throw new Error("hype-momentum.buildProposal: no spike close for entry");
    }
    const stop = round2(entry * (1 - this.params.stopPct));
    const target = round2(entry * (1 + this.params.takeProfitPct));
    const tpPct = (this.params.takeProfitPct * 100).toFixed(0);
    return {
      strategyId: this.id,
      signalId: signal.id,
      ticker: signal.ticker,
      side: "long",
      requestedQty: 100,
      entry: round2(entry),
      stop,
      target,
      exitPlan: {
        stopLoss: stop,
        takeProfit: target,
        rules: [
          `Take half off at +${tpPct}%`,
          `Exit the remainder on a close below the ${this.params.maExitWindow}-day MA`,
          "Momentum-stall exit: first heavy-volume red day or lower high",
          "HARD RULE: exit before any earnings date — never hold into the print",
        ],
        notes:
          "Early-momentum ride with pre-written exits; move fast on the first stall.",
      },
    };
  }

  manage(position: Position, _ctx: MarketContext): ExitAction | null {
    const view = this.views.get(position.ticker);
    if (!view) return null;
    return hypeExitDecision(view, this.params);
  }
}

/** Mean of the last `window` volumes (or null if not enough history). */
function trailingAvgVolume(
  candles: { volume: number }[],
  window: number,
): number | null {
  if (candles.length < window || window <= 0) return null;
  let sum = 0;
  for (let i = candles.length - window; i < candles.length; i++) {
    sum += candles[i]!.volume;
  }
  return sum / window;
}

/** Read a numeric metric that may be undefined, with a fallback. */
function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Round to cents (prices cross the wire as 2dp). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
