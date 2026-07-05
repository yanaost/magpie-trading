/**
 * Strategy #3 — QUAL/SPHB quality-rotation pair (spec §3, T1.7).
 *
 * Thesis: the `SPHB/QUAL` ratio (high-beta ÷ quality) rises during risk-on
 * euphoria and mean-reverts. When it stretches a band above its 20-week SMA, the
 * speculative leg is over-extended and the rotation into quality is favored — so
 * we go **long QUAL** and hold until the ratio reverts back to its SMA.
 *
 * Weekly cadence. The entry is a fresh cross of the ratio above `SMA·(1+band)`
 * (one signal per stretch, not every bar it stays extended). The written exit is
 * mean-reversion: close QUAL when the ratio falls back to/below its SMA. A hard
 * stop under a recent QUAL swing low backs the thesis exit.
 *
 * ## Sync-manage contract
 * `Strategy.manage` is synchronous but the reversion test needs candle data,
 * which the read-only {@link MarketContext} only exposes asynchronously. So the
 * strategy caches the latest {@link RatioView} during `scan` (which the engine
 * runs each cycle before the position monitor) and `manage` reads that cache.
 * The cache is keyed by nothing — a single pair, at most one open position.
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
import { ratioView, type RatioView } from "./indicators.js";

/** Tunable parameters (defaults from the spec). */
export interface QualSphbParams {
  /** SMA window on the ratio, in weeks. */
  smaWeeks: number;
  /** Entry band: ratio must exceed `SMA·(1+entryBand)` to trigger. */
  entryBand: number;
  /** Weekly candle timeframe key stored in `candles.timeframe`. */
  candleTimeframe: string;
  /** How many weeks of history to pull for the ratio/SMA. */
  lookbackBars: number;
  /** Hard-stop distance below QUAL entry as a fraction (backs the thesis exit). */
  stopPct: number;
  /** Swing-low lookback (weeks) for the protective stop. */
  swingLowBars: number;
}

export const DEFAULT_QUAL_SPHB_PARAMS: QualSphbParams = Object.freeze({
  smaWeeks: 20,
  entryBand: 0.05,
  candleTimeframe: "1w",
  lookbackBars: 60,
  stopPct: 0.08,
  swingLowBars: 4,
});

const HIGH_BETA: Ticker = "SPHB";
const QUALITY: Ticker = "QUAL";

export class QualSphbStrategy implements Strategy {
  readonly id = "qual-sphb";
  readonly name = "QUAL/SPHB Rotation";
  readonly timeframe: StrategyTimeframe = "weekly";
  readonly defaultMode: Mode = "APPROVE";
  readonly riskParams: RiskParams;

  private readonly params: QualSphbParams;
  /** Latest ratio view cached by `scan`, read synchronously by `manage`. */
  private view: RatioView | null = null;
  /** Latest QUAL close cached by `scan`, for stop/entry math in `manage`. */
  private lastQualClose: number | null = null;

  constructor(
    params: Partial<QualSphbParams> = {},
    riskParams: RiskParams = DEFAULT_RISK_PARAMS,
  ) {
    this.params = { ...DEFAULT_QUAL_SPHB_PARAMS, ...params };
    this.riskParams = riskParams;
  }

  async universe(): Promise<Ticker[]> {
    return [QUALITY, HIGH_BETA];
  }

  async scan(ctx: MarketContext): Promise<QuantSignal[]> {
    const [sphb, qual] = await Promise.all([
      ctx.candles(
        HIGH_BETA,
        this.params.candleTimeframe,
        this.params.lookbackBars,
      ),
      ctx.candles(
        QUALITY,
        this.params.candleTimeframe,
        this.params.lookbackBars,
      ),
    ]);
    // Refresh the sync-manage cache every scan (see class docstring).
    this.view = ratioView(sphb, qual, this.params.smaWeeks);
    this.lastQualClose = lastClose(qual);

    const view = this.view;
    if (!view || this.lastQualClose === null) return [];

    // Trigger only on a *fresh* cross above the band — not every extended bar.
    const band = 1 + this.params.entryBand;
    const crossedUp =
      view.ratio >= view.sma * band &&
      view.prevRatio !== null &&
      view.prevSma !== null &&
      view.prevRatio < view.prevSma * band;
    if (!crossedUp) return [];

    return [
      {
        strategyId: this.id,
        ticker: QUALITY,
        trigger: {
          kind: "ratio-stretch",
          ratio: view.ratio,
          sma: view.sma,
          band: this.params.entryBand,
          note: "SPHB/QUAL stretched above its SMA — rotate into quality",
        },
        quantMetrics: {
          ratio: view.ratio,
          sma: view.sma,
          stretchPct: view.ratio / view.sma - 1,
          qualClose: this.lastQualClose,
        },
      },
    ];
  }

  llmPrompt(signal: QuantSignal): AnalysisRequest {
    return {
      strategyId: this.id,
      ticker: QUALITY,
      prompt:
        "The SPHB/QUAL high-beta-vs-quality ratio has stretched above its 20-week " +
        "average, a mean-reversion setup to rotate long QUAL (quality). Verify there " +
        "is no idiosyncratic reason this rotation should be skipped now (e.g. a " +
        "regime break, index reconstitution, or headline that invalidates the mean " +
        "reversion). Answer proceed or veto only.",
      context: {
        ratio: signal.quantMetrics.ratio,
        sma: signal.quantMetrics.sma,
        stretchPct: signal.quantMetrics.stretchPct,
      },
      requiredChecks: [
        "No QUAL/SPHB index methodology or reconstitution change pending",
        "No macro regime break that would keep high-beta leading",
      ],
      webSearch: true,
    };
  }

  buildProposal(signal: QuantSignal, _analysis: LLMAnalysis): ProposalDraft {
    const entry =
      numericMetric(signal.quantMetrics.qualClose) ?? this.lastQualClose;
    if (entry === null) {
      throw new Error(
        "qual-sphb.buildProposal: no QUAL close available for entry",
      );
    }
    const stop = round2(entry * (1 - this.params.stopPct));
    return {
      strategyId: this.id,
      signalId: signal.id,
      ticker: QUALITY,
      side: "long",
      // A nominal requested size; the risk manager sizes to the stop distance.
      requestedQty: 100,
      entry: round2(entry),
      stop,
      exitPlan: {
        stopLoss: stop,
        rules: [
          `Exit when SPHB/QUAL reverts to/below its ${this.params.smaWeeks}-week SMA`,
          `Hard stop ${(this.params.stopPct * 100).toFixed(0)}% below entry`,
        ],
        notes:
          "Mean-reversion pair rotation; thesis exit is ratio-driven, not price-target.",
      },
    };
  }

  manage(position: Position, _ctx: MarketContext): ExitAction | null {
    // Thesis exit: the ratio has reverted to/below its SMA — the rotation is done.
    const view = this.view;
    if (view && view.ratio <= view.sma) {
      return {
        kind: "close",
        reason: `SPHB/QUAL reverted to its SMA (ratio ${view.ratio.toFixed(4)} ≤ sma ${view.sma.toFixed(
          4,
        )}) — rotation complete`,
      };
    }
    // Hard stop is enforced by the bracket; nothing else to adjust intra-hold.
    void position;
    return null;
  }
}

/** Latest close of a candle series, or `null` when empty. */
function lastClose(candles: Candle[]): number | null {
  const last = candles[candles.length - 1];
  return last ? last.close : null;
}

/** Read a numeric quant metric that may be undefined. */
function numericMetric(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Round to cents (prices cross the wire as 2dp). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
