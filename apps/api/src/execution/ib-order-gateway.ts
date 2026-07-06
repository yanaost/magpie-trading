/**
 * The order-side seam over `@stoqey/ib` (T2.1), mirroring the market-data
 * adapter's {@link import("../market-data/ib-connection.js").IbConnection}
 * pattern: a narrow interface the {@link import("./ib-execution-port.js").IbExecutionPort}
 * depends on, plus a real implementation that wraps an `IBApi` instance. The
 * port is unit-tested against a fake gateway so the whole bracket/reconcile
 * path is exercised without a live paper gateway (AC: reconciliation test).
 *
 * The gateway owns the raw broker protocol: the monotonic `nextValidId`
 * allocator, buffering `execDetails`/`commissionReport` into a single fill
 * event (they arrive as two messages keyed by `execId`), and collecting the
 * one-shot snapshot streams (`position`/`positionEnd`, `openOrder`/
 * `openOrderEnd`) into resolved promises. Everything above it speaks in our
 * own domain shapes, never IB's positional event args.
 */
import { EventEmitter } from "node:events";

/** A US-equity contract, the only kind this MVP routes to a broker. */
export interface EquityContract {
  /** Ticker symbol. */
  readonly symbol: string;
  /** Always "STK" for equities. */
  readonly secType: "STK";
  /** Smart routing. */
  readonly exchange: "SMART";
  /** USD. */
  readonly currency: "USD";
}

/** Build the SMART-routed USD equity contract for a ticker. */
export function equityContract(symbol: string): EquityContract {
  return { symbol, secType: "STK", exchange: "SMART", currency: "USD" };
}

/** How one bracket leg should be priced when placed at the broker. */
export interface BrokerOrderSpec {
  /** Broker order id (from {@link IbOrderGateway.allocateOrderId}). */
  readonly orderId: number;
  /** BUY opens/closes per side. */
  readonly action: "BUY" | "SELL";
  /** Shares. */
  readonly totalQuantity: number;
  /** Market, limit, or stop. */
  readonly orderType: "MKT" | "LMT" | "STP";
  /** Limit price (LMT). */
  readonly lmtPrice?: number;
  /** Stop trigger price (STP). */
  readonly auxPrice?: number;
  /** Parent order id — links a child leg to its bracket parent. */
  readonly parentId?: number;
  /** Time-in-force. */
  readonly tif: "DAY" | "GTC";
  /**
   * Whether this order transmits immediately. A bracket is staged with the
   * parent + earlier children at `transmit:false` and the final leg at
   * `transmit:true`, so IB receives the whole OCA group atomically.
   */
  readonly transmit: boolean;
}

/** A broker order-status transition (subset of IB's `orderStatus` event). */
export interface BrokerOrderStatus {
  /** Broker order id. */
  readonly orderId: number;
  /** Raw IB status string (PreSubmitted, Submitted, Filled, Cancelled, …). */
  readonly status: string;
  /** Cumulative filled quantity. */
  readonly filled: number;
  /** Remaining quantity. */
  readonly remaining: number;
  /** Average fill price so far. */
  readonly avgFillPrice: number;
}

/** A completed fill: `execDetails` joined with its `commissionReport`. */
export interface BrokerFill {
  /** Broker execution id. */
  readonly execId: string;
  /** Order this fill is against. */
  readonly orderId: number;
  /** Ticker. */
  readonly symbol: string;
  /** "BOT" (buy) or "SLD" (sell) from IB, normalized to buy/sell. */
  readonly action: "buy" | "sell";
  /** Shares filled. */
  readonly shares: number;
  /** Fill price. */
  readonly price: number;
  /** Commission charged (USD); 0 until the commissionReport arrives. */
  readonly commission: number;
  /** Broker execution time. */
  readonly time: Date;
}

/** A broker-side open order, as seen during reconciliation. */
export interface BrokerOpenOrder {
  /** Broker order id. */
  readonly orderId: number;
  /** Ticker. */
  readonly symbol: string;
  /** BUY/SELL. */
  readonly action: string;
  /** Shares. */
  readonly totalQuantity: number;
  /** Order type. */
  readonly orderType: string;
  /** Current status. */
  readonly status: string;
}

/** A broker-side net position, as seen during reconciliation. */
export interface BrokerPosition {
  /** Account id. */
  readonly account: string;
  /** Ticker. */
  readonly symbol: string;
  /** Signed net position (negative = short). */
  readonly position: number;
  /** Average cost per share. */
  readonly avgCost: number;
}

/** Events the gateway emits to the execution port. */
export interface IbOrderGatewayEvents {
  ready: () => void;
  orderStatus: (status: BrokerOrderStatus) => void;
  fill: (fill: BrokerFill) => void;
  error: (err: { code?: number; message?: string; orderId?: number }) => void;
}

/**
 * The narrow order-side broker interface the execution port depends on. Both
 * the real {@link IbApiOrderGateway} and the test fake implement it.
 */
export interface IbOrderGateway extends EventEmitter {
  /** Connect and resolve once the broker has handed us a valid order-id base. */
  connect(): Promise<void>;
  /** Permanently disconnect. */
  disconnect(): void;
  /** Whether the broker link is currently up. */
  isConnected(): boolean;
  /** Allocate the next monotonic broker order id. */
  allocateOrderId(): number;
  /** Submit one order leg. */
  placeOrder(contract: EquityContract, order: BrokerOrderSpec): void;
  /** Cancel a working order by broker id. */
  cancelOrder(orderId: number): void;
  /** Snapshot all open orders at the broker (reconciliation). */
  fetchOpenOrders(): Promise<BrokerOpenOrder[]>;
  /** Snapshot all net positions at the broker (reconciliation). */
  fetchPositions(): Promise<BrokerPosition[]>;
  /** Broker-reported net liquidation value (cash + marked positions), for sizing. */
  fetchNetLiquidation(): Promise<number>;
}

/** The subset of the `@stoqey/ib` `IBApi` surface the gateway drives. */
export interface IbOrderApi {
  connect(clientId?: number): unknown;
  disconnect(): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
  reqIds(numIds?: number): unknown;
  placeOrder(orderId: number, contract: unknown, order: unknown): unknown;
  cancelOrder(orderId: number, orderCancelParam?: unknown): unknown;
  reqAllOpenOrders(): unknown;
  reqPositions(): unknown;
  reqAccountSummary(reqId: number, group: string, tags: string): unknown;
  cancelAccountSummary(reqId: number): unknown;
}

/** Fixed request id for our single-shot account-summary snapshots. */
const ACCT_SUMMARY_REQ_ID = 9001;

/** Factory so the real `IBApi` construction is injectable/deferred. */
export type IbOrderApiFactory = (opts: {
  host: string;
  port: number;
  clientId: number;
}) => IbOrderApi;

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));

/**
 * The real gateway: wraps an `IBApi` and normalizes its positional events into
 * {@link IbOrderGatewayEvents}. Construction opens no socket; {@link connect}
 * does, and resolves on the first `nextValidId`.
 */
export class IbApiOrderGateway extends EventEmitter implements IbOrderGateway {
  private api: IbOrderApi | null = null;
  private connected = false;
  private nextId: number | null = null;
  /** execId → partial fill awaiting its commission report (or vice-versa). */
  private readonly pendingFills = new Map<string, Partial<BrokerFill>>();
  private positionsBuf: BrokerPosition[] = [];
  private openOrdersBuf: BrokerOpenOrder[] = [];
  private positionsWaiters: Array<(p: BrokerPosition[]) => void> = [];
  private openOrdersWaiters: Array<(o: BrokerOpenOrder[]) => void> = [];
  /** Latest NetLiquidation seen in the in-flight account-summary snapshot. */
  private nlvBuf: number | null = null;
  private nlvWaiters: Array<(v: number) => void> = [];

  constructor(
    private readonly opts: {
      host: string;
      port: number;
      clientId: number;
      factory: IbOrderApiFactory;
      logger?: Pick<Console, "log" | "warn" | "error">;
    },
  ) {
    super();
  }

  private get logger(): Pick<Console, "log" | "warn" | "error"> {
    return this.opts.logger ?? console;
  }

  isConnected(): boolean {
    return this.connected;
  }

  allocateOrderId(): number {
    if (this.nextId === null) {
      throw new Error("IB gateway not ready: no valid order id yet");
    }
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const api = this.opts.factory({
        host: this.opts.host,
        port: this.opts.port,
        clientId: this.opts.clientId,
      });
      this.api = api;
      let settled = false;

      api.on("nextValidId", (...args: unknown[]) => {
        const id = num(args[0]);
        // Only the first nextValidId seeds the base; later ones are ignored so
        // our monotonic allocator is never rewound under the broker.
        if (this.nextId === null) this.nextId = id;
        this.connected = true;
        if (!settled) {
          settled = true;
          this.emit("ready");
          resolve();
        }
      });

      api.on("orderStatus", (...args: unknown[]) => {
        const [orderId, status, filled, remaining, avgFillPrice] = args;
        this.emit("orderStatus", {
          orderId: num(orderId),
          status: String(status),
          filled: num(filled),
          remaining: num(remaining),
          avgFillPrice: num(avgFillPrice),
        });
      });

      api.on("execDetails", (...args: unknown[]) => {
        // (reqId, contract, execution)
        const exec = args[2] as Record<string, unknown>;
        const contract = args[1] as Record<string, unknown>;
        const execId = String(exec.execId ?? "");
        if (!execId) return;
        const side = String(exec.side ?? "").toUpperCase();
        const partial: Partial<BrokerFill> = {
          execId,
          orderId: num(exec.orderId),
          symbol: String(contract.symbol ?? ""),
          action: side === "SLD" || side === "SELL" ? "sell" : "buy",
          shares: num(exec.shares),
          price: num(exec.price),
          time: this.parseIbTime(exec.time),
        };
        this.mergeFill(execId, partial);
      });

      api.on("commissionReport", (...args: unknown[]) => {
        const report = args[0] as Record<string, unknown>;
        const execId = String(report.execId ?? "");
        if (!execId) return;
        this.mergeFill(execId, { commission: num(report.commission) });
      });

      api.on("position", (...args: unknown[]) => {
        const [account, contract, pos, avgCost] = args;
        const c = contract as Record<string, unknown>;
        this.positionsBuf.push({
          account: String(account),
          symbol: String(c.symbol ?? ""),
          position: num(pos),
          avgCost: num(avgCost),
        });
      });
      api.on("positionEnd", () => {
        const batch = this.positionsBuf;
        this.positionsBuf = [];
        for (const w of this.positionsWaiters.splice(0)) w(batch);
      });

      api.on("openOrder", (...args: unknown[]) => {
        const [orderId, contract, order, state] = args;
        const c = contract as Record<string, unknown>;
        const o = order as Record<string, unknown>;
        const s = state as Record<string, unknown>;
        this.openOrdersBuf.push({
          orderId: num(orderId),
          symbol: String(c.symbol ?? ""),
          action: String(o.action ?? ""),
          totalQuantity: num(o.totalQuantity),
          orderType: String(o.orderType ?? ""),
          status: String(s.status ?? ""),
        });
      });
      api.on("openOrderEnd", () => {
        const batch = this.openOrdersBuf;
        this.openOrdersBuf = [];
        for (const w of this.openOrdersWaiters.splice(0)) w(batch);
      });

      api.on("accountSummary", (...args: unknown[]) => {
        // (reqId, account, tag, value, currency)
        const [, , tag, value] = args;
        if (String(tag) === "NetLiquidation") this.nlvBuf = num(value);
      });
      api.on("accountSummaryEnd", () => {
        const v = this.nlvBuf ?? 0;
        this.nlvBuf = null;
        // The request is a subscription; cancel it now that we have the snapshot.
        try {
          this.api?.cancelAccountSummary(ACCT_SUMMARY_REQ_ID);
        } catch {
          // best-effort
        }
        for (const w of this.nlvWaiters.splice(0)) w(v);
      });

      api.on("error", (...args: unknown[]) => {
        const [err, code, orderId] = args;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[ib-order] error${typeof code === "number" ? ` (${code})` : ""}: ${message}`,
        );
        this.emit("error", {
          message,
          code: typeof code === "number" ? code : undefined,
          orderId: typeof orderId === "number" ? orderId : undefined,
        });
      });

      api.on("disconnected", () => {
        this.connected = false;
        this.logger.warn("[ib-order] gateway disconnected");
      });

      try {
        api.connect(this.opts.clientId);
        api.reqIds(0);
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  /** Join the execDetails and commissionReport halves; emit once both seen. */
  private mergeFill(execId: string, part: Partial<BrokerFill>): void {
    const merged = { ...this.pendingFills.get(execId), ...part };
    // A fill is complete once we have both the execution body and commission.
    if (
      merged.orderId !== undefined &&
      merged.shares !== undefined &&
      merged.commission !== undefined
    ) {
      this.pendingFills.delete(execId);
      this.emit("fill", {
        commission: 0,
        ...merged,
      } as BrokerFill);
    } else {
      this.pendingFills.set(execId, merged);
    }
  }

  private parseIbTime(raw: unknown): Date {
    // IB exec time is "yyyymmdd  hh:mm:ss" (local). Fall back to now-safe epoch.
    const s = String(raw ?? "").trim();
    const m = /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if (!m) return new Date(0);
    const [, y, mo, d, h, mi, se] = m;
    return new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(se),
    );
  }

  placeOrder(contract: EquityContract, order: BrokerOrderSpec): void {
    if (!this.api) throw new Error("IB gateway not connected");
    this.api.placeOrder(order.orderId, contract, {
      action: order.action,
      totalQuantity: order.totalQuantity,
      orderType: order.orderType,
      lmtPrice: order.lmtPrice,
      auxPrice: order.auxPrice,
      parentId: order.parentId,
      tif: order.tif,
      transmit: order.transmit,
    });
  }

  cancelOrder(orderId: number): void {
    if (!this.api) throw new Error("IB gateway not connected");
    this.api.cancelOrder(orderId);
  }

  fetchOpenOrders(): Promise<BrokerOpenOrder[]> {
    if (!this.api) return Promise.reject(new Error("IB gateway not connected"));
    return new Promise((resolve) => {
      this.openOrdersWaiters.push(resolve);
      this.api!.reqAllOpenOrders();
    });
  }

  fetchPositions(): Promise<BrokerPosition[]> {
    if (!this.api) return Promise.reject(new Error("IB gateway not connected"));
    return new Promise((resolve) => {
      this.positionsWaiters.push(resolve);
      this.api!.reqPositions();
    });
  }

  fetchNetLiquidation(): Promise<number> {
    if (!this.api) return Promise.reject(new Error("IB gateway not connected"));
    return new Promise((resolve) => {
      this.nlvWaiters.push(resolve);
      this.api!.reqAccountSummary(ACCT_SUMMARY_REQ_ID, "All", "NetLiquidation");
    });
  }

  disconnect(): void {
    this.connected = false;
    if (!this.api) return;
    try {
      this.api.removeAllListeners();
      this.api.disconnect();
    } catch {
      // best-effort
    }
    this.api = null;
  }
}
