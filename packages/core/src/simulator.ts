/**
 * The Simulator (spec §4.4, T1.4) — an in-memory {@link ExecutionPort} so a
 * strategy cannot tell SIM from PAPER/LIVE. It owns one isolated virtual
 * portfolio per strategy instance (`sim_portfolios`), a deliberately pessimistic
 * fill model (fills at bid/ask never mid, configurable slippage, IB commissions),
 * and bracket semantics: parent entry + protective stop + optional take-profit,
 * with stop/target monitored against incoming bars as a one-cancels-other pair.
 *
 * Like {@link RiskManager} it does no I/O: it is a pure state machine driven by
 * market events ({@link Simulator.onBar}/{@link Simulator.updateQuote}). The
 * caller (T1.6 pipeline) persists the emitted {@link Fill}s, positions, and the
 * {@link PortfolioResetRecord} to the db and the audit log. Determinism is a
 * hard requirement (replay, T3.1): no `Date.now`/`Math.random` — ids come from a
 * monotonic counter and every timestamp is threaded in from a market event.
 */
import { z } from "zod";
import { bpsToFraction, roundCents } from "./index.js";
import type { ExecutionTarget, Side } from "./enums.js";
import type { Candle, Quote, Ticker } from "./market.js";
import { PositionSchema, type Position } from "./position.js";
import {
  LivePromotionLockedError,
  type BracketHandle,
  type BracketOrderRequest,
  type Fill,
  type OrderModification,
  type OrderRef,
  ExecutionPort,
} from "./execution.js";
import { FillSchema, BracketOrderRequestSchema } from "./execution.js";

/** IB fixed-tier US-equity commission model (spec §4.4). */
export const CommissionModelSchema = z.object({
  /** USD per share. */
  perShare: z.number().finite().nonnegative().default(0.005),
  /** Minimum charged per order. */
  minPerOrder: z.number().finite().nonnegative().default(1.0),
  /** Cap as a fraction of trade value. */
  maxPctOfTradeValue: z.number().finite().positive().default(0.01),
});
/** Parameters of the IB fixed commission schedule. */
export type CommissionModel = z.infer<typeof CommissionModelSchema>;

/** Simulator configuration; every field has a pessimistic default. */
export const SimulatorConfigSchema = z.object({
  /** Opening virtual cash for a fresh portfolio (USD). */
  startingCash: z.number().finite().positive().default(100_000),
  /** Adverse slippage applied to every fill, in basis points (spec: 5 bps). */
  slippageBps: z.number().finite().nonnegative().default(5),
  /** Spread synthesized around a bare mark when no real quote exists, in bps. */
  syntheticSpreadBps: z.number().finite().nonnegative().default(10),
  /** IB commission schedule. */
  commission: CommissionModelSchema.default({}),
});
/** Validated simulator configuration. */
export type SimulatorConfig = z.infer<typeof SimulatorConfigSchema>;

/** A synthesized or real top-of-book, used by the fill model. */
export interface BidAsk {
  /** Best bid. */
  readonly bid: number;
  /** Best ask. */
  readonly ask: number;
}

/**
 * IB fixed-tier commission for one equity fill: `perShare × qty`, floored at
 * `minPerOrder` and capped at `maxPctOfTradeValue` of the trade's value.
 * @param qty - shares filled
 * @param price - fill price
 * @param model - commission schedule (defaults to the IB fixed tier)
 * @returns commission in USD, rounded to cents
 */
export function ibCommission(
  qty: number,
  price: number,
  model: CommissionModel = CommissionModelSchema.parse({}),
): number {
  const raw = model.perShare * qty;
  const cap = model.maxPctOfTradeValue * qty * price;
  return roundCents(Math.min(Math.max(raw, model.minPerOrder), cap));
}

/**
 * Derive a bid/ask from a single mark price (e.g. a bar close) when no live
 * quote is available — the fill model never fills at mid (spec §4.4).
 * @param mark - reference price
 * @param spreadBps - full synthetic spread in basis points
 */
export function synthesizeQuote(mark: number, spreadBps: number): BidAsk {
  const half = (mark * bpsToFraction(spreadBps)) / 2;
  return { bid: mark - half, ask: mark + half };
}

/**
 * Marketable fill price: a buy lifts the ask, a sell hits the bid, each degraded
 * further by adverse slippage. This is the only place a price becomes a fill, so
 * it is intentionally the pessimistic corner of the book.
 * @param action - "buy" or "sell"
 * @param quote - the bid/ask to fill against
 * @param slippageBps - adverse slippage in basis points
 */
export function marketFillPrice(
  action: "buy" | "sell",
  quote: BidAsk,
  slippageBps: number,
): number {
  const slip = bpsToFraction(slippageBps);
  return action === "buy" ? quote.ask * (1 + slip) : quote.bid * (1 - slip);
}

/** The broker action that opens or closes a given side. */
function openAction(side: Side): "buy" | "sell" {
  return side === "long" ? "buy" : "sell";
}
function closeAction(side: Side): "buy" | "sell" {
  return side === "long" ? "sell" : "buy";
}

/** Snapshot returned when a portfolio is reset, for the caller to audit. */
export interface PortfolioResetRecord {
  /** Strategy instance whose portfolio was reset. */
  readonly strategyInstanceId: string;
  /** Cash before the reset. */
  readonly cashBefore: number;
  /** Realized P&L accumulated before the reset. */
  readonly realizedPnlBefore: number;
  /** Open positions discarded by the reset. */
  readonly openPositionsClosed: number;
  /** Cash the portfolio was restored to. */
  readonly cashAfter: number;
  /** When the reset happened (threaded from the caller). */
  readonly resetAt: Date;
}

/** Which bracket leg triggered an exit, and at what reference price. */
interface ExitTrigger {
  readonly leg: "stop" | "target";
  readonly reference: number;
}

/**
 * A trade that fully closed on this rung, with its realized P&L — the unit the
 * AUTO-mode governor (T3.4) counts wins/losses in. Buffered as brackets close
 * and drained by the pipeline each monitor tick.
 */
export interface SimClosedTrade {
  /** Strategy instance that owned the bracket. */
  readonly strategyId: string;
  /** Bracket that closed. */
  readonly bracketId: string;
  /** Symbol. */
  readonly ticker: Ticker;
  /** Long or short. */
  readonly side: Side;
  /** Shares/contracts closed. */
  readonly qty: number;
  /** Average entry price (for R-multiple reporting); undefined if never filled. */
  readonly entryPrice?: number;
  /** Protective stop at entry (for R-multiple reporting). */
  readonly stopPrice: number;
  /** Realized P&L for the trade, net of commissions (USD). */
  readonly realizedPnl: number;
  /** When the trade closed. */
  readonly closedAt: Date;
}

/** A working or closed bracket tracked inside a portfolio. */
interface SimBracket {
  bracketId: string;
  strategyId: string;
  ticker: Ticker;
  side: Side;
  qty: number;
  stopPrice: number;
  targetPrice?: number;
  status: "pending" | "open" | "closed" | "cancelled";
  entryPrice?: number;
  openedAt?: Date;
  closedAt?: Date;
  avgExitPrice?: number;
  realizedPnl: number;
  orderIds: { parent: string; stop: string; target?: string };
  entry: { type: "market" | "limit"; limitPrice?: number };
}

/** Internal, mutable state of one virtual portfolio. */
interface SimPortfolio {
  strategyInstanceId: string;
  startingCash: number;
  cash: number;
  realizedPnl: number;
  brackets: Map<string, SimBracket>;
}

/**
 * In-app execution port for the SIM rung. Drive it with {@link Simulator.onBar}
 * (and optionally {@link Simulator.updateQuote} for live-sim quotes); it fills
 * entries, monitors brackets one-cancels-other, and keeps each strategy's
 * virtual cash and positions reconciled to the cent.
 */
export class Simulator implements ExecutionPort {
  /** This port always drives the SIM rung. */
  readonly target: ExecutionTarget = "SIM";

  private readonly cfg: SimulatorConfig;
  private readonly portfolios = new Map<string, SimPortfolio>();
  /** Last market event per ticker: a synthesized/real quote plus its time. */
  private readonly marks = new Map<Ticker, { quote: BidAsk; ts: Date }>();
  /** All fills produced, newest last — the caller drains/persists these. */
  private readonly fills: Fill[] = [];
  /** Trades that fully closed since the last drain (T3.4 governor input). */
  private readonly closed: SimClosedTrade[] = [];
  /** bracketId → owning strategy instance, for O(1) lookup across portfolios. */
  private readonly bracketOwner = new Map<string, string>();
  private seq = 0;

  /**
   * @param config - fill-model and starting-cash configuration (all optional)
   */
  constructor(config: Partial<SimulatorConfig> = {}) {
    this.cfg = SimulatorConfigSchema.parse(config);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `sim-${prefix}${this.seq}`;
  }

  /** Which strategy instance a strategy's orders route to (id[:variant]). */
  private portfolioFor(strategyInstanceId: string): SimPortfolio {
    let p = this.portfolios.get(strategyInstanceId);
    if (!p) {
      p = {
        strategyInstanceId,
        startingCash: this.cfg.startingCash,
        cash: this.cfg.startingCash,
        realizedPnl: 0,
        brackets: new Map(),
      };
      this.portfolios.set(strategyInstanceId, p);
    }
    return p;
  }

  /** The current bid/ask for a ticker, or `null` if no market event seen yet. */
  private quoteFor(ticker: Ticker): { quote: BidAsk; ts: Date } | null {
    return this.marks.get(ticker) ?? null;
  }

  /**
   * Feed a live top-of-book quote (live-sim). Fills any pending market entries on
   * that ticker at the new quote. Bracket stop/target monitoring happens on bars.
   * @param quote - the observed quote
   */
  updateQuote(quote: Quote): void {
    const bid = quote.bid ?? quote.last ?? quote.ask;
    const ask = quote.ask ?? quote.last ?? quote.bid;
    if (bid == null || ask == null) return; // nothing to fill against
    this.marks.set(quote.ticker, { quote: { bid, ask }, ts: quote.ts });
    this.fillPendingEntries(quote.ticker, quote.ts);
  }

  /**
   * Advance the simulation by one bar: refresh the mark, fill pending entries,
   * then check every open bracket on this ticker for a stop/target hit. When a
   * single bar spans both levels the stop is assumed hit first (pessimistic), so
   * a bracket can never realize both legs.
   * @param bar - the OHLCV bar just closed
   */
  onBar(bar: Candle): void {
    this.marks.set(bar.ticker, {
      quote: synthesizeQuote(bar.close, this.cfg.syntheticSpreadBps),
      ts: bar.ts,
    });
    this.fillPendingEntries(bar.ticker, bar.ts, bar);
    for (const p of this.portfolios.values()) {
      for (const b of p.brackets.values()) {
        if (b.status !== "open" || b.ticker !== bar.ticker) continue;
        const trigger = this.detectExit(b, bar);
        if (trigger)
          this.closeBracket(p, b, trigger.leg, trigger.reference, bar.ts);
      }
    }
  }

  /** Fill pending parent entries for a ticker against the current quote/bar. */
  private fillPendingEntries(ticker: Ticker, ts: Date, bar?: Candle): void {
    const mk = this.quoteFor(ticker);
    if (!mk) return;
    for (const p of this.portfolios.values()) {
      for (const b of p.brackets.values()) {
        if (b.status !== "pending" || b.ticker !== ticker) continue;
        if (b.entry.type === "limit") {
          // A limit entry only fills once price trades through the limit.
          const lim = b.entry.limitPrice!;
          const touched = bar
            ? bar.low <= lim && lim <= bar.high
            : b.side === "long"
              ? mk.quote.ask <= lim
              : mk.quote.bid >= lim;
          if (!touched) continue;
        }
        this.openBracket(p, b, mk.quote, ts);
      }
    }
  }

  /** Execute the parent entry and open the position. */
  private openBracket(
    p: SimPortfolio,
    b: SimBracket,
    quote: BidAsk,
    ts: Date,
  ): void {
    const price = roundCents(
      marketFillPrice(openAction(b.side), quote, this.cfg.slippageBps),
    );
    const commission = ibCommission(b.qty, price, this.cfg.commission);
    // Long ties up cash (debit); short receives proceeds (credit). Commission
    // is always a debit.
    const notional = roundCents(b.qty * price);
    const cashDelta =
      b.side === "long"
        ? roundCents(-(notional + commission))
        : roundCents(notional - commission);
    p.cash = roundCents(p.cash + cashDelta);
    b.status = "open";
    b.entryPrice = price;
    b.openedAt = ts;
    this.recordFill(
      b.orderIds.parent,
      b.ticker,
      openAction(b.side) === "buy" ? "long" : "short",
      b.qty,
      price,
      commission,
      ts,
    );
  }

  /** Close a full bracket via its stop or target leg (one-cancels-other). */
  private closeBracket(
    p: SimPortfolio,
    b: SimBracket,
    leg: "stop" | "target",
    reference: number,
    ts: Date,
  ): void {
    const quote = synthesizeQuote(reference, this.cfg.syntheticSpreadBps);
    const price = roundCents(
      marketFillPrice(closeAction(b.side), quote, this.cfg.slippageBps),
    );
    const commission = ibCommission(b.qty, price, this.cfg.commission);
    const notional = roundCents(b.qty * price);
    // Closing a long sells (credit); closing a short buys back (debit).
    const cashDelta =
      b.side === "long"
        ? roundCents(notional - commission)
        : roundCents(-(notional + commission));
    p.cash = roundCents(p.cash + cashDelta);
    const gross =
      b.side === "long"
        ? roundCents(b.qty * (price - b.entryPrice!))
        : roundCents(b.qty * (b.entryPrice! - price));
    const entryCommission = ibCommission(
      b.qty,
      b.entryPrice!,
      this.cfg.commission,
    );
    const realized = roundCents(gross - entryCommission - commission);
    b.realizedPnl = realized;
    p.realizedPnl = roundCents(p.realizedPnl + realized);
    b.status = "closed";
    b.avgExitPrice = price;
    b.closedAt = ts;
    this.recordClosed(b, ts);
    this.recordFill(
      leg === "stop" ? b.orderIds.stop : b.orderIds.target!,
      b.ticker,
      closeAction(b.side) === "buy" ? "long" : "short",
      b.qty,
      price,
      commission,
      ts,
    );
  }

  /** Whether this bar triggers the bracket's stop or target (stop wins ties). */
  private detectExit(b: SimBracket, bar: Candle): ExitTrigger | null {
    if (b.side === "long") {
      if (bar.low <= b.stopPrice) {
        // Gap-through fills below the stop; take the worse of stop/open.
        return { leg: "stop", reference: Math.min(b.stopPrice, bar.open) };
      }
      if (b.targetPrice !== undefined && bar.high >= b.targetPrice) {
        return { leg: "target", reference: b.targetPrice };
      }
    } else {
      if (bar.high >= b.stopPrice) {
        return { leg: "stop", reference: Math.max(b.stopPrice, bar.open) };
      }
      if (b.targetPrice !== undefined && bar.low <= b.targetPrice) {
        return { leg: "target", reference: b.targetPrice };
      }
    }
    return null;
  }

  /** Buffer a just-closed bracket for the governor to drain (T3.4). */
  private recordClosed(b: SimBracket, ts: Date): void {
    this.closed.push({
      strategyId: b.strategyId,
      bracketId: b.bracketId,
      ticker: b.ticker,
      side: b.side,
      qty: b.qty,
      entryPrice: b.entryPrice,
      stopPrice: b.stopPrice,
      realizedPnl: b.realizedPnl,
      closedAt: ts,
    });
  }

  private recordFill(
    orderId: string,
    ticker: Ticker,
    side: Side,
    qty: number,
    price: number,
    commission: number,
    filledAt: Date,
  ): void {
    this.fills.push(
      FillSchema.parse({
        orderId,
        target: this.target,
        ticker,
        side,
        qty,
        price,
        commission,
        filledAt,
      }),
    );
  }

  // ---- ExecutionPort -------------------------------------------------------

  /** {@inheritDoc ExecutionPort.placeBracket} */
  async placeBracket(req: BracketOrderRequest): Promise<BracketHandle> {
    const r = BracketOrderRequestSchema.parse(req);
    if (r.target === "LIVE") {
      throw new LivePromotionLockedError("simulator");
    }
    const bracketId = this.nextId("b");
    const parentId = this.nextId("o");
    const stopId = this.nextId("o");
    const targetId = r.targetPrice !== undefined ? this.nextId("o") : undefined;
    const p = this.portfolioFor(r.strategyId);
    const bracket: SimBracket = {
      bracketId,
      strategyId: r.strategyId,
      ticker: r.ticker,
      side: r.side,
      qty: r.qty,
      stopPrice: r.stopPrice,
      targetPrice: r.targetPrice,
      status: "pending",
      realizedPnl: 0,
      orderIds: { parent: parentId, stop: stopId, target: targetId },
      entry: { type: r.entryType, limitPrice: r.limitPrice },
    };
    p.brackets.set(bracketId, bracket);
    this.bracketOwner.set(bracketId, r.strategyId);
    // A market entry fills immediately when a quote already exists (live-sim);
    // otherwise it waits for the next market event.
    if (r.entryType === "market") {
      const mk = this.quoteFor(r.ticker);
      if (mk) this.openBracket(p, bracket, mk.quote, mk.ts);
    }
    return this.handleFor(bracket);
  }

  /** {@inheritDoc ExecutionPort.modifyBracket} */
  async modifyBracket(mod: OrderModification): Promise<void> {
    const b = this.lookup(mod.bracketId);
    if (b.status !== "open" && b.status !== "pending") {
      throw new Error(
        `Bracket ${mod.bracketId} is ${b.status}; cannot modify.`,
      );
    }
    if (mod.newStopPrice !== undefined) b.stopPrice = mod.newStopPrice;
    if (mod.newTargetPrice !== undefined) b.targetPrice = mod.newTargetPrice;
    if (mod.newQty !== undefined) {
      if (mod.newQty >= b.qty) {
        throw new Error(
          `Downward-only: newQty ${mod.newQty} must be below current ${b.qty} (no averaging up).`,
        );
      }
      // A reduction scales out the difference at market (partial close).
      const reduceBy = b.qty - mod.newQty;
      if (b.status === "open") this.scaleOut(b, reduceBy);
      else b.qty = mod.newQty; // still pending: just resize the entry
    }
  }

  /** Partially close an open bracket by `reduceBy` shares at the current mark. */
  private scaleOut(b: SimBracket, reduceBy: number): void {
    const p = this.portfolioFor(b.strategyId);
    const mk = this.quoteFor(b.ticker);
    if (!mk) throw new Error(`No market for ${b.ticker}; cannot scale out.`);
    const price = roundCents(
      marketFillPrice(closeAction(b.side), mk.quote, this.cfg.slippageBps),
    );
    const commission = ibCommission(reduceBy, price, this.cfg.commission);
    const notional = roundCents(reduceBy * price);
    const cashDelta =
      b.side === "long"
        ? roundCents(notional - commission)
        : roundCents(-(notional + commission));
    p.cash = roundCents(p.cash + cashDelta);
    const gross =
      b.side === "long"
        ? roundCents(reduceBy * (price - b.entryPrice!))
        : roundCents(reduceBy * (b.entryPrice! - price));
    const entryCommission = ibCommission(
      reduceBy,
      b.entryPrice!,
      this.cfg.commission,
    );
    const realized = roundCents(gross - entryCommission - commission);
    b.realizedPnl = roundCents(b.realizedPnl + realized);
    p.realizedPnl = roundCents(p.realizedPnl + realized);
    b.qty -= reduceBy;
    this.recordFill(
      b.orderIds.parent,
      b.ticker,
      closeAction(b.side) === "buy" ? "long" : "short",
      reduceBy,
      price,
      commission,
      mk.ts,
    );
  }

  /** {@inheritDoc ExecutionPort.cancelBracket} */
  async cancelBracket(bracketId: string): Promise<void> {
    const b = this.lookup(bracketId);
    if (b.status === "pending") {
      b.status = "cancelled";
      return;
    }
    if (b.status === "open") {
      // No naked positions in this system: cancelling a filled bracket flattens
      // it at the current mark.
      const mk = this.quoteFor(b.ticker);
      if (!mk) throw new Error(`No market for ${b.ticker}; cannot flatten.`);
      const reference = mk.quote; // close at current book
      const p = this.portfolioFor(b.strategyId);
      const price = roundCents(
        marketFillPrice(closeAction(b.side), reference, this.cfg.slippageBps),
      );
      const commission = ibCommission(b.qty, price, this.cfg.commission);
      const notional = roundCents(b.qty * price);
      const cashDelta =
        b.side === "long"
          ? roundCents(notional - commission)
          : roundCents(-(notional + commission));
      p.cash = roundCents(p.cash + cashDelta);
      const gross =
        b.side === "long"
          ? roundCents(b.qty * (price - b.entryPrice!))
          : roundCents(b.qty * (b.entryPrice! - price));
      const entryCommission = ibCommission(
        b.qty,
        b.entryPrice!,
        this.cfg.commission,
      );
      const realized = roundCents(gross - entryCommission - commission);
      b.realizedPnl = realized;
      p.realizedPnl = roundCents(p.realizedPnl + realized);
      b.status = "closed";
      b.avgExitPrice = price;
      b.closedAt = mk.ts;
      this.recordClosed(b, mk.ts);
      this.recordFill(
        b.orderIds.parent,
        b.ticker,
        closeAction(b.side) === "buy" ? "long" : "short",
        b.qty,
        price,
        commission,
        mk.ts,
      );
    }
  }

  /** {@inheritDoc ExecutionPort.getPositions} */
  async getPositions(strategyId?: string): Promise<Position[]> {
    const out: Position[] = [];
    for (const p of this.portfolios.values()) {
      for (const b of p.brackets.values()) {
        if (b.status !== "open") continue;
        if (strategyId && b.strategyId !== strategyId) continue;
        out.push(this.positionFor(b));
      }
    }
    return out;
  }

  /** {@inheritDoc ExecutionPort.getFills} */
  async getFills(since?: Date): Promise<Fill[]> {
    return since
      ? this.fills.filter((f) => f.filledAt >= since)
      : [...this.fills];
  }

  /**
   * Drain the trades that have fully closed since the last drain (T3.4). With a
   * `strategyId`, returns and removes only that strategy's closed trades and
   * leaves the rest buffered — so each per-strategy monitor tick consumes its
   * own results without discarding another strategy's. The realized P&L is the
   * closing leg's net figure; its sign is what the governor counts as a
   * win/loss.
   * @param strategyId - when given, only this strategy's closed trades
   */
  drainClosedTrades(strategyId?: string): SimClosedTrade[] {
    if (strategyId === undefined) {
      const out = [...this.closed];
      this.closed.length = 0;
      return out;
    }
    const out: SimClosedTrade[] = [];
    const keep: SimClosedTrade[] = [];
    for (const t of this.closed) {
      (t.strategyId === strategyId ? out : keep).push(t);
    }
    this.closed.length = 0;
    this.closed.push(...keep);
    return out;
  }

  // ---- Sim-only surface (persistence/analytics live in apps/api) -----------

  /**
   * Reset a strategy instance's virtual portfolio to starting cash, discarding
   * open positions. Returns a snapshot for the caller to write to `audit_log`
   * and stamp `sim_portfolios.reset_at`.
   * @param strategyInstanceId - portfolio to reset
   * @param at - reset timestamp (threaded from the caller's clock)
   */
  resetPortfolio(strategyInstanceId: string, at: Date): PortfolioResetRecord {
    const p = this.portfolioFor(strategyInstanceId);
    const open = [...p.brackets.values()].filter(
      (b) => b.status === "open",
    ).length;
    const record: PortfolioResetRecord = {
      strategyInstanceId,
      cashBefore: p.cash,
      realizedPnlBefore: p.realizedPnl,
      openPositionsClosed: open,
      cashAfter: p.startingCash,
      resetAt: at,
    };
    p.cash = p.startingCash;
    p.realizedPnl = 0;
    p.brackets.clear();
    return record;
  }

  /** Current virtual cash for a strategy instance. */
  cash(strategyInstanceId: string): number {
    return this.portfolioFor(strategyInstanceId).cash;
  }

  /** Realized P&L accumulated by a strategy instance. */
  realizedPnl(strategyInstanceId: string): number {
    return this.portfolioFor(strategyInstanceId).realizedPnl;
  }

  private lookup(bracketId: string): SimBracket {
    const owner = this.bracketOwner.get(bracketId);
    const b = owner
      ? this.portfolios.get(owner)?.brackets.get(bracketId)
      : undefined;
    if (!b) throw new Error(`Unknown bracket ${bracketId}.`);
    return b;
  }

  private positionFor(b: SimBracket): Position {
    return PositionSchema.parse({
      strategyId: b.strategyId,
      target: this.target,
      ticker: b.ticker,
      side: b.side,
      status: "open",
      qty: b.qty,
      avgEntryPrice: b.entryPrice,
      stopPrice: b.stopPrice,
      realizedPnl: 0,
      unrealizedPnl: 0,
      openedAt: b.openedAt,
    });
  }

  private handleFor(b: SimBracket): BracketHandle {
    const leg = (
      orderId: string,
      role: OrderRef["role"],
      extra: Partial<OrderRef> = {},
    ): OrderRef => ({
      orderId,
      role,
      status: role === "parent" && b.status === "open" ? "filled" : "working",
      ticker: b.ticker,
      side: b.side,
      qty: b.qty,
      ...extra,
    });
    return {
      bracketId: b.bracketId,
      parent: leg(b.orderIds.parent, "parent", {
        limitPrice: b.entry.limitPrice,
      }),
      stop: leg(b.orderIds.stop, "stop", { stopPrice: b.stopPrice }),
      target:
        b.orderIds.target && b.targetPrice !== undefined
          ? leg(b.orderIds.target, "target", { limitPrice: b.targetPrice })
          : undefined,
    };
  }
}
