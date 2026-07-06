/**
 * Per-strategy performance math (T2.3). Pure, deterministic reductions over a
 * strategy's *closed* trades — win rate, average R-multiple, max drawdown, and
 * the realized-PnL equity curve. Lives in core (not the API) so the money-path
 * math is unit-testable in isolation and reused wherever performance is shown.
 *
 * R-multiple: a trade's realized PnL expressed in units of the risk taken at
 * entry (qty × |entry − stop|). A +2R trade made twice what it risked; a −1R
 * trade lost exactly its planned risk. Trades opened without a stop have no
 * definable risk and are excluded from the avg-R average (but still counted in
 * win rate and the equity curve).
 */
import { z } from "zod";

/** Round to cent granularity so equity-curve sums don't accrue float dust. */
function roundCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** One closed trade, the minimal input the performance math needs. */
export const ClosedTradeSchema = z.object({
  /** Realized profit/loss in account currency (can be negative). */
  realizedPnl: z.number(),
  /** Filled quantity (absolute size). */
  qty: z.number().positive(),
  /** Average entry price. */
  entryPrice: z.number().positive(),
  /** Protective stop at entry, if one was set (used for R). */
  stopPrice: z.number().positive().optional(),
  /** When the trade closed — orders the equity curve. */
  closedAt: z.date(),
});
export type ClosedTrade = z.infer<typeof ClosedTradeSchema>;

/** A single point on the cumulative realized-PnL curve. */
export interface EquityPoint {
  /** ISO timestamp of the trade that produced this point. */
  readonly t: string;
  /** Cumulative realized PnL through this trade. */
  readonly equity: number;
}

/** Aggregate performance for a set of closed trades. */
export interface PerformanceStats {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  /** Fraction of trades with positive realized PnL, 0..1 (0 when no trades). */
  readonly winRate: number;
  /** Mean R-multiple across trades that had a stop (0 when none). */
  readonly avgR: number;
  /** Sum of realized PnL across all trades. */
  readonly totalPnl: number;
  /** Largest peak-to-trough drop on the equity curve, ≥ 0. */
  readonly maxDrawdown: number;
  /** Cumulative realized-PnL curve, in close order. */
  readonly equityCurve: EquityPoint[];
}

/** The R-multiple of a single closed trade, or null if it had no stop. */
export function rMultiple(trade: ClosedTrade): number | null {
  if (trade.stopPrice === undefined) return null;
  const riskPerShare = Math.abs(trade.entryPrice - trade.stopPrice);
  const risk = riskPerShare * trade.qty;
  if (risk === 0) return null;
  return trade.realizedPnl / risk;
}

/** Empty-set performance (used when a strategy has no closed trades yet). */
export function emptyPerformance(): PerformanceStats {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    avgR: 0,
    totalPnl: 0,
    maxDrawdown: 0,
    equityCurve: [],
  };
}

/**
 * Reduce a strategy's closed trades into {@link PerformanceStats}.
 * @param trades - closed trades (any order; sorted by close time internally)
 */
export function computePerformance(
  trades: readonly ClosedTrade[],
): PerformanceStats {
  if (trades.length === 0) return emptyPerformance();

  const ordered = [...trades].sort(
    (a, b) => a.closedAt.getTime() - b.closedAt.getTime(),
  );

  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  let rSum = 0;
  let rCount = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equityCurve: EquityPoint[] = [];

  for (const trade of ordered) {
    if (trade.realizedPnl > 0) wins += 1;
    else if (trade.realizedPnl < 0) losses += 1;
    totalPnl += trade.realizedPnl;

    const r = rMultiple(trade);
    if (r !== null) {
      rSum += r;
      rCount += 1;
    }

    equity = roundCents(equity + trade.realizedPnl);
    peak = Math.max(peak, equity);
    // Drawdown is measured from the running high-water mark.
    maxDrawdown = Math.max(maxDrawdown, roundCents(peak - equity));
    equityCurve.push({ t: trade.closedAt.toISOString(), equity });
  }

  return {
    trades: ordered.length,
    wins,
    losses,
    winRate: wins / ordered.length,
    avgR: rCount === 0 ? 0 : rSum / rCount,
    totalPnl: roundCents(totalPnl),
    maxDrawdown,
    equityCurve,
  };
}
