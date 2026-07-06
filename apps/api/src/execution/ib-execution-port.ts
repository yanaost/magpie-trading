/**
 * The IB paper-account {@link ExecutionPort} (T2.1). It implements the same
 * behavioral interface as the {@link import("@magpie/core").Simulator}, so the
 * pipeline cannot tell SIM from PAPER: every entry is a bracket (parent + stop +
 * optional take-profit), placed as an OCA group at the broker so the exits live
 * broker-side and survive a gateway daily-restart (spec §4.3).
 *
 * Unlike the Simulator, fills are asynchronous: {@link placeBracket} returns as
 * soon as the legs are staged and transmitted, and the bracket only becomes
 * `open` when the broker reports the parent filled. The port keeps a small
 * in-memory model of each bracket keyed by our stable `bracketId`, updated from
 * the gateway's `orderStatus`/`fill` events, and exposes attributed positions
 * (per strategy) plus buffered fills for the pipeline to persist. Broker-truth
 * reconciliation (rogue orders/positions) lives in {@link import("./ib-reconciliation.js").reconcile}.
 */
import {
  FillSchema,
  BracketOrderRequestSchema,
  LivePromotionLockedError,
  PositionSchema,
  type BracketHandle,
  type BracketOrderRequest,
  type ExecutionTarget,
  type Fill,
  type OrderModification,
  type OrderRef,
  type Position,
  type Side,
  type ExecutionPort,
} from "@magpie/core";
import {
  equityContract,
  type BrokerFill,
  type BrokerOrderSpec,
  type BrokerOrderStatus,
  type IbOrderGateway,
} from "./ib-order-gateway.js";

/** Map an IB order-status string onto our order lifecycle. */
export function mapIbStatus(
  ib: string,
):
  | "pending_submit"
  | "submitted"
  | "working"
  | "filled"
  | "cancelled"
  | "rejected" {
  switch (ib) {
    case "PendingSubmit":
    case "ApiPending":
      return "pending_submit";
    case "PreSubmitted":
      return "submitted";
    case "Submitted":
      return "working";
    case "Filled":
      return "filled";
    case "Cancelled":
    case "ApiCancelled":
    case "PendingCancel":
      return "cancelled";
    default:
      // Inactive / Unknown ⇒ the broker rejected or parked the order.
      return "rejected";
  }
}

/** One tracked bracket leg's live state. */
interface LegState {
  readonly orderId: number;
  readonly role: "parent" | "stop" | "target";
  status: ReturnType<typeof mapIbStatus>;
}

/** A working or closed bracket tracked inside the port. */
interface IbBracket {
  bracketId: string;
  strategyId: string;
  ticker: string;
  side: Side;
  qty: number;
  stopPrice: number;
  targetPrice?: number;
  status: "pending" | "open" | "closed" | "cancelled";
  entryPrice?: number;
  openedAt?: Date;
  legs: { parent: LegState; stop: LegState; target?: LegState };
}

const openAction = (side: Side): "BUY" | "SELL" =>
  side === "long" ? "BUY" : "SELL";
const closeAction = (side: Side): "BUY" | "SELL" =>
  side === "long" ? "SELL" : "BUY";

/**
 * PAPER-rung execution port backed by an {@link IbOrderGateway}. Construction is
 * cheap and opens no socket; {@link start} connects the gateway and wires the
 * fill/status listeners.
 */
export class IbExecutionPort implements ExecutionPort {
  readonly target: ExecutionTarget = "PAPER";

  private readonly brackets = new Map<string, IbBracket>();
  /** broker orderId → owning bracketId, for O(1) event routing. */
  private readonly orderIndex = new Map<number, string>();
  private readonly fills: Fill[] = [];
  private seq = 0;
  private started = false;

  constructor(
    private readonly gateway: IbOrderGateway,
    private readonly logger: Pick<Console, "log" | "warn" | "error"> = console,
  ) {}

  /** Connect the gateway and subscribe to broker events. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.gateway.on("orderStatus", (s) => this.onOrderStatus(s));
    this.gateway.on("fill", (f) => this.onFill(f));
    if (!this.gateway.isConnected()) await this.gateway.connect();
  }

  private nextBracketId(): string {
    this.seq += 1;
    return `ib-b${this.seq}`;
  }

  /** {@inheritDoc ExecutionPort.placeBracket} */
  async placeBracket(req: BracketOrderRequest): Promise<BracketHandle> {
    const r = BracketOrderRequestSchema.parse(req);
    if (r.target === "LIVE") throw new LivePromotionLockedError("ib");
    if (r.target !== "PAPER") {
      throw new Error(`IB port only routes PAPER, got ${r.target}`);
    }
    await this.start();

    const contract = equityContract(r.ticker);
    const parentId = this.gateway.allocateOrderId();
    const stopId = this.gateway.allocateOrderId();
    const hasTarget = r.targetPrice !== undefined;
    const targetId = hasTarget ? this.gateway.allocateOrderId() : undefined;

    const bracket: IbBracket = {
      bracketId: this.nextBracketId(),
      strategyId: r.strategyId,
      ticker: r.ticker,
      side: r.side,
      qty: r.qty,
      stopPrice: r.stopPrice,
      targetPrice: r.targetPrice,
      status: "pending",
      legs: {
        parent: { orderId: parentId, role: "parent", status: "pending_submit" },
        stop: { orderId: stopId, role: "stop", status: "pending_submit" },
        target: targetId
          ? { orderId: targetId, role: "target", status: "pending_submit" }
          : undefined,
      },
    };
    this.brackets.set(bracket.bracketId, bracket);
    this.orderIndex.set(parentId, bracket.bracketId);
    this.orderIndex.set(stopId, bracket.bracketId);
    if (targetId) this.orderIndex.set(targetId, bracket.bracketId);

    // Stage the OCA group: parent + stop (+ target) with only the last leg
    // transmitting, so the broker receives the whole bracket atomically.
    const parent: BrokerOrderSpec = {
      orderId: parentId,
      action: openAction(r.side),
      totalQuantity: r.qty,
      orderType: r.entryType === "limit" ? "LMT" : "MKT",
      lmtPrice: r.limitPrice,
      tif: r.timeInForce,
      transmit: false,
    };
    const stop: BrokerOrderSpec = {
      orderId: stopId,
      action: closeAction(r.side),
      totalQuantity: r.qty,
      orderType: "STP",
      auxPrice: r.stopPrice,
      parentId,
      tif: "GTC",
      transmit: !hasTarget,
    };
    this.gateway.placeOrder(contract, parent);
    this.gateway.placeOrder(contract, stop);
    if (hasTarget && targetId) {
      const target: BrokerOrderSpec = {
        orderId: targetId,
        action: closeAction(r.side),
        totalQuantity: r.qty,
        orderType: "LMT",
        lmtPrice: r.targetPrice,
        parentId,
        tif: "GTC",
        transmit: true,
      };
      this.gateway.placeOrder(contract, target);
    }
    return this.handleFor(bracket);
  }

  private onOrderStatus(s: BrokerOrderStatus): void {
    const bracketId = this.orderIndex.get(s.orderId);
    if (!bracketId) return;
    const b = this.brackets.get(bracketId);
    if (!b) return;
    const mapped = mapIbStatus(s.status);
    const leg = this.legByOrderId(b, s.orderId);
    if (leg) leg.status = mapped;

    if (leg?.role === "parent" && mapped === "filled") {
      if (b.status === "pending") {
        b.status = "open";
        b.entryPrice = s.avgFillPrice;
        // Exact fill time arrives with the execDetails 'fill' event; stamp now
        // so the position is well-formed even if that event is delayed.
        if (!b.openedAt) b.openedAt = new Date();
      }
    }
    // A protective leg filling closes the position (broker OCA cancels the
    // sibling); reflect that in our model.
    if (
      (leg?.role === "stop" || leg?.role === "target") &&
      mapped === "filled"
    ) {
      b.status = "closed";
    }
    if (mapped === "cancelled" && leg?.role === "parent") {
      b.status = "cancelled";
    }
  }

  private onFill(f: BrokerFill): void {
    const bracketId = this.orderIndex.get(f.orderId);
    if (!bracketId) return;
    const b = this.brackets.get(bracketId);
    if (!b) return;
    // Persist the entry price from the actual execution when the parent fills.
    const leg = this.legByOrderId(b, f.orderId);
    if (leg?.role === "parent" && b.entryPrice === undefined) {
      b.entryPrice = f.price;
      if (b.status === "pending") b.status = "open";
      if (!b.openedAt) b.openedAt = f.time;
    }
    this.fills.push(
      FillSchema.parse({
        orderId: String(f.orderId),
        target: this.target,
        brokerExecId: f.execId,
        ticker: f.symbol,
        side: f.action === "buy" ? "long" : "short",
        qty: f.shares,
        price: f.price,
        commission: f.commission,
        filledAt: f.time,
      }),
    );
  }

  private legByOrderId(b: IbBracket, orderId: number): LegState | undefined {
    if (b.legs.parent.orderId === orderId) return b.legs.parent;
    if (b.legs.stop.orderId === orderId) return b.legs.stop;
    if (b.legs.target?.orderId === orderId) return b.legs.target;
    return undefined;
  }

  /** {@inheritDoc ExecutionPort.modifyBracket} */
  async modifyBracket(mod: OrderModification): Promise<void> {
    const b = this.brackets.get(mod.bracketId);
    if (!b) throw new Error(`Unknown bracket ${mod.bracketId}`);
    if (b.status !== "open" && b.status !== "pending") {
      throw new Error(
        `Bracket ${mod.bracketId} is ${b.status}; cannot modify.`,
      );
    }
    if (mod.newQty !== undefined && mod.newQty >= b.qty) {
      throw new Error(
        `Downward-only: newQty ${mod.newQty} must be below current ${b.qty}.`,
      );
    }
    const contract = equityContract(b.ticker);
    // Re-place the stop leg with the same broker id to amend it (IB treats a
    // placeOrder on an existing id as a modification).
    if (mod.newStopPrice !== undefined) b.stopPrice = mod.newStopPrice;
    if (mod.newQty !== undefined) b.qty = mod.newQty;
    this.gateway.placeOrder(contract, {
      orderId: b.legs.stop.orderId,
      action: closeAction(b.side),
      totalQuantity: b.qty,
      orderType: "STP",
      auxPrice: b.stopPrice,
      parentId: b.legs.parent.orderId,
      tif: "GTC",
      transmit: true,
    });
    if (mod.newTargetPrice !== undefined && b.legs.target) {
      b.targetPrice = mod.newTargetPrice;
      this.gateway.placeOrder(contract, {
        orderId: b.legs.target.orderId,
        action: closeAction(b.side),
        totalQuantity: b.qty,
        orderType: "LMT",
        lmtPrice: b.targetPrice,
        parentId: b.legs.parent.orderId,
        tif: "GTC",
        transmit: true,
      });
    }
  }

  /** {@inheritDoc ExecutionPort.cancelBracket} */
  async cancelBracket(bracketId: string): Promise<void> {
    const b = this.brackets.get(bracketId);
    if (!b) throw new Error(`Unknown bracket ${bracketId}`);
    // Cancelling the parent cancels the whole OCA group at the broker.
    this.gateway.cancelOrder(b.legs.parent.orderId);
    this.gateway.cancelOrder(b.legs.stop.orderId);
    if (b.legs.target) this.gateway.cancelOrder(b.legs.target.orderId);
    b.status = "cancelled";
    this.logger.log(`[ib-port] cancelled bracket ${bracketId} (${b.ticker})`);
  }

  /** {@inheritDoc ExecutionPort.getPositions} */
  async getPositions(strategyId?: string): Promise<Position[]> {
    const out: Position[] = [];
    for (const b of this.brackets.values()) {
      if (b.status !== "open") continue;
      if (strategyId && b.strategyId !== strategyId) continue;
      out.push(
        PositionSchema.parse({
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
        }),
      );
    }
    return out;
  }

  /** {@inheritDoc ExecutionPort.getFills} */
  async getFills(since?: Date): Promise<Fill[]> {
    return since
      ? this.fills.filter((f) => f.filledAt >= since)
      : [...this.fills];
  }

  /** Bracket ids currently tracked (for reconciliation against the broker). */
  trackedBrackets(): ReadonlyArray<{
    bracketId: string;
    ticker: string;
    side: Side;
    qty: number;
    status: IbBracket["status"];
    orderIds: number[];
  }> {
    return [...this.brackets.values()].map((b) => ({
      bracketId: b.bracketId,
      ticker: b.ticker,
      side: b.side,
      qty: b.qty,
      status: b.status,
      orderIds: [
        b.legs.parent.orderId,
        b.legs.stop.orderId,
        ...(b.legs.target ? [b.legs.target.orderId] : []),
      ],
    }));
  }

  private handleFor(b: IbBracket): BracketHandle {
    const leg = (l: LegState, extra: Partial<OrderRef> = {}): OrderRef => ({
      orderId: String(l.orderId),
      role: l.role,
      status: l.status === "pending_submit" ? "pending_submit" : l.status,
      ticker: b.ticker,
      side: b.side,
      qty: b.qty,
      ...extra,
    });
    return {
      bracketId: b.bracketId,
      parent: leg(b.legs.parent),
      stop: leg(b.legs.stop, { stopPrice: b.stopPrice }),
      target:
        b.legs.target && b.targetPrice !== undefined
          ? leg(b.legs.target, { limitPrice: b.targetPrice })
          : undefined,
    };
  }
}
