/**
 * Strategy #8 — Valuation gravity (spec §3, T2.8). WATCH-only by construction.
 *
 * It tracks five retail-darling names against an established peer and, in the
 * two weeks after each earnings report, journals how the darling's price-to-
 * sales multiple sits relative to that peer. The thesis it is *gathering
 * evidence for* — that stretched multiples revert ("valuation gravity") — is
 * never traded here. There is no order-placement path at all:
 *
 *   - `buildProposal` is typed `never` and throws — it is statically impossible
 *     for this strategy to produce a {@link ProposalDraft} (T2.8 AC).
 *   - `manage` always returns `null` — no position can exist to manage.
 *
 * All the strategy "does" is emit journal observations from `scan`, which the
 * dashboard renders as a running log on the strategy's tab.
 */
import {
  type AnalysisRequest,
  type ExitAction,
  type LLMAnalysis,
  type MarketContext,
  type Mode,
  type Position,
  type QuantSignal,
  type RiskParams,
  type StrategyTimeframe,
  type Strategy,
  type StrategyMeta,
  type Ticker,
  DEFAULT_RISK_PARAMS,
} from "@magpie/core";
import {
  type CalendarProvider,
  StaticCalendarProvider,
} from "../earnings-fade/calendar.js";
import {
  VALUATION_WATCHLIST,
  StaticValuationDataProvider,
  type ValuationDataProvider,
  type ValuationPair,
} from "./watchlist.js";
import {
  buildJournalEntries,
  DEFAULT_VALUATION_GRAVITY_PARAMS,
  type ValuationGravityParams,
  type ValuationJournalEntry,
} from "./journal.js";

export class ValuationGravityStrategy implements Strategy {
  readonly id = "valuation-gravity";
  readonly name = "Valuation Gravity";
  readonly timeframe: StrategyTimeframe = "observation";
  readonly defaultMode: Mode = "WATCH";
  readonly riskParams: RiskParams;
  readonly meta: StrategyMeta = {
    summary:
      "A watch-only research notebook, not a trading strategy. It tracks a handful " +
      "of expensive retail-darling stocks against a solid peer and records how " +
      "stretched their valuation looks after each earnings report. It never places " +
      "an order — it is purely gathering evidence that rich multiples eventually revert.",
    mechanic: {
      trigger: [
        "In the two weeks after a darling reports earnings, its price-to-sales multiple is compared to an established peer",
        "The observation is journaled — no entry signal is ever produced",
      ],
      exitPlan: [
        "Not applicable — this strategy holds no positions and cannot place a trade",
      ],
      llmRole:
        "Claude adds plain-language color on whether the valuation gap looks justified, purely for the journal.",
      dataNeeds:
        "Fundamentals feed for price-to-sales multiples (not yet wired)",
    },
    dataReady: false,
  };

  private readonly watchlist: readonly ValuationPair[];
  private readonly calendar: CalendarProvider;
  private readonly valuation: ValuationDataProvider;
  private readonly params: ValuationGravityParams;

  constructor(
    watchlist: readonly ValuationPair[] = VALUATION_WATCHLIST,
    calendar: CalendarProvider = new StaticCalendarProvider(),
    valuation: ValuationDataProvider = new StaticValuationDataProvider(),
    params: Partial<ValuationGravityParams> = {},
    riskParams: RiskParams = DEFAULT_RISK_PARAMS,
  ) {
    this.watchlist = watchlist;
    this.calendar = calendar;
    this.valuation = valuation;
    this.params = { ...DEFAULT_VALUATION_GRAVITY_PARAMS, ...params };
    this.riskParams = riskParams;
  }

  async universe(_ctx: MarketContext): Promise<Ticker[]> {
    return this.watchlist.map((p) => p.ticker);
  }

  /**
   * Emit one journal observation per watchlist name currently inside its
   * two-week post-earnings window. These are records, not trade triggers.
   */
  async scan(ctx: MarketContext): Promise<QuantSignal[]> {
    const asOf = ctx.now.toISOString().slice(0, 10);
    const earnings = await this.calendar.recentEarnings(ctx.now);

    // Resolve every P/S we might need once, so journaling stays pure/sync.
    const wanted = new Set<Ticker>();
    for (const p of this.watchlist) {
      wanted.add(p.ticker);
      wanted.add(p.peer);
    }
    const ps = new Map<Ticker, number | null>();
    for (const t of wanted) {
      ps.set(t, await this.valuation.priceToSales(t, ctx.now));
    }

    const entries = buildJournalEntries(
      asOf,
      this.id,
      this.watchlist,
      earnings,
      (t) => ps.get(t) ?? null,
      this.params,
    );
    return entries.map((e) => this.toSignal(e));
  }

  private toSignal(entry: ValuationJournalEntry): QuantSignal {
    return {
      strategyId: this.id,
      ticker: entry.ticker,
      trigger: {
        kind: "valuation-journal",
        peer: entry.peer,
        reportDate: entry.reportDate,
        note: entry.note,
      },
      quantMetrics: {
        daysSinceReport: entry.daysSinceReport,
        priceToSales: entry.priceToSales ?? Number.NaN,
        peerPriceToSales: entry.peerPriceToSales ?? Number.NaN,
        psPremium: entry.psPremium ?? Number.NaN,
      },
    };
  }

  /**
   * A journaling annotation prompt — NOT a trade decision. Asks Claude to note
   * whether the post-report drift supports or contradicts the mean-reversion
   * thesis. The pipeline never turns this into an order (see `buildProposal`).
   */
  llmPrompt(signal: QuantSignal): AnalysisRequest {
    return {
      strategyId: this.id,
      ticker: signal.ticker,
      prompt:
        `Annotate the valuation-gravity journal for ${signal.ticker}. It is in ` +
        "the two weeks after an earnings report and trading at the recorded P/S " +
        "multiple relative to its peer. Note qualitatively whether the post-report " +
        "price action is starting to compress the premium (multiple reverting) or " +
        "not. This is an observation only — do not recommend a trade.",
      context: {
        peer: signal.trigger.peer,
        priceToSales: signal.quantMetrics.priceToSales,
        peerPriceToSales: signal.quantMetrics.peerPriceToSales,
        psPremium: signal.quantMetrics.psPremium,
      },
      requiredChecks: ["Note only — no trade recommendation"],
      webSearch: false,
    };
  }

  /**
   * No order-placement path exists. This strategy only journals, so turning a
   * signal into a trade is statically impossible: the return type is `never`.
   */
  buildProposal(_signal: QuantSignal, _analysis: LLMAnalysis): never {
    throw new Error(
      "valuation-gravity is WATCH-only: it journals and never places orders",
    );
  }

  /** No position can ever exist for this strategy, so there is nothing to manage. */
  manage(_position: Position, _ctx: MarketContext): ExitAction | null {
    return null;
  }
}
