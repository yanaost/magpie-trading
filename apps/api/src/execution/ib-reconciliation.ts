/**
 * Startup / periodic reconciliation (T2.1, spec §4.3): diff what the broker
 * actually holds against what our system believes it placed, and surface every
 * mismatch so a human is alerted rather than the system silently trading around
 * a rogue order or an orphaned position. This is pure — it takes the two
 * snapshots and returns findings; the caller decides how loudly to alert.
 */
import type { BrokerOpenOrder, BrokerPosition } from "./ib-order-gateway.js";

/** What our system believes it has working at the broker. */
export interface KnownState {
  /** Broker order ids we placed and still consider live. */
  readonly knownOrderIds: ReadonlySet<number>;
  /** Net position per ticker we believe we hold (signed; negative = short). */
  readonly knownPositions: ReadonlyMap<string, number>;
}

/** A single reconciliation discrepancy. */
export interface ReconMismatch {
  /** What kind of drift this is. */
  readonly kind:
    | "rogue_order" // at broker, not in our books
    | "missing_order" // in our books, not at broker
    | "rogue_position" // held at broker, we expected none/less
    | "position_drift"; // held at broker, differs from our expected qty
  /** Ticker, when applicable. */
  readonly ticker?: string;
  /** Broker order id, when applicable. */
  readonly orderId?: number;
  /** Our expected quantity (positions). */
  readonly expected?: number;
  /** The broker's actual quantity (positions). */
  readonly actual?: number;
  /** Human-readable explanation for the alert. */
  readonly detail: string;
}

/**
 * Reconcile broker open orders + positions against our known state.
 * @param brokerOrders - open orders reported by the broker
 * @param brokerPositions - net positions reported by the broker
 * @param known - what our system believes it placed / holds
 * @returns every discrepancy found (empty ⇒ fully reconciled)
 */
export function reconcile(
  brokerOrders: readonly BrokerOpenOrder[],
  brokerPositions: readonly BrokerPosition[],
  known: KnownState,
): ReconMismatch[] {
  const out: ReconMismatch[] = [];

  const brokerOrderIds = new Set(brokerOrders.map((o) => o.orderId));
  for (const o of brokerOrders) {
    if (!known.knownOrderIds.has(o.orderId)) {
      out.push({
        kind: "rogue_order",
        orderId: o.orderId,
        ticker: o.symbol,
        detail: `Broker has order ${o.orderId} (${o.action} ${o.totalQuantity} ${o.symbol}, ${o.orderType}/${o.status}) that our system did not place.`,
      });
    }
  }
  for (const id of known.knownOrderIds) {
    if (!brokerOrderIds.has(id)) {
      out.push({
        kind: "missing_order",
        orderId: id,
        detail: `Our system believes order ${id} is working, but the broker reports no such open order.`,
      });
    }
  }

  const seen = new Set<string>();
  for (const p of brokerPositions) {
    if (p.position === 0) continue;
    seen.add(p.symbol);
    const expected = known.knownPositions.get(p.symbol) ?? 0;
    if (expected === 0) {
      out.push({
        kind: "rogue_position",
        ticker: p.symbol,
        expected: 0,
        actual: p.position,
        detail: `Broker holds ${p.position} ${p.symbol} that our system did not open.`,
      });
    } else if (expected !== p.position) {
      out.push({
        kind: "position_drift",
        ticker: p.symbol,
        expected,
        actual: p.position,
        detail: `Position drift on ${p.symbol}: expected ${expected}, broker holds ${p.position}.`,
      });
    }
  }
  for (const [ticker, expected] of known.knownPositions) {
    if (expected !== 0 && !seen.has(ticker)) {
      out.push({
        kind: "position_drift",
        ticker,
        expected,
        actual: 0,
        detail: `We expected ${expected} ${ticker}, but the broker reports a flat position.`,
      });
    }
  }
  return out;
}
