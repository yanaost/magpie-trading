/**
 * IbApiOrderGateway unit tests (T2.1, order module → money path). Drive the real
 * gateway against a fake IBApi (an EventEmitter with recording stubs) to prove:
 * connect resolves on the first nextValidId and seeds a monotonic id allocator;
 * positional broker events are normalized into domain shapes; execDetails +
 * commissionReport are joined into a single 'fill'; and open-orders/positions
 * snapshots resolve on their *End events.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IbApiOrderGateway, type IbOrderApi } from "./ib-order-gateway.js";

class FakeApi extends EventEmitter implements IbOrderApi {
  readonly placed: Array<{
    orderId: number;
    contract: unknown;
    order: unknown;
  }> = [];
  readonly cancelled: number[] = [];
  reqIdsCalls = 0;
  reqOpenCalls = 0;
  reqPosCalls = 0;
  connect = vi.fn(() => undefined);
  disconnect = vi.fn(() => undefined);
  reqIds = vi.fn(() => {
    this.reqIdsCalls += 1;
  });
  placeOrder(orderId: number, contract: unknown, order: unknown): unknown {
    this.placed.push({ orderId, contract, order });
    return undefined;
  }
  cancelOrder(orderId: number): unknown {
    this.cancelled.push(orderId);
    return undefined;
  }
  reqAllOpenOrders = vi.fn(() => {
    this.reqOpenCalls += 1;
  });
  reqPositions = vi.fn(() => {
    this.reqPosCalls += 1;
  });
  reqAcctSummaryCalls = 0;
  cancelAcctSummaryCalls = 0;
  reqAccountSummary = vi.fn(() => {
    this.reqAcctSummaryCalls += 1;
  });
  cancelAccountSummary = vi.fn(() => {
    this.cancelAcctSummaryCalls += 1;
  });
}

function makeGateway() {
  const api = new FakeApi();
  const gateway = new IbApiOrderGateway({
    host: "localhost",
    port: 4002,
    clientId: 11,
    factory: () => api,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { api, gateway };
}

describe("IbApiOrderGateway.connect", () => {
  it("resolves on the first nextValidId and seeds a monotonic allocator", async () => {
    const { api, gateway } = makeGateway();
    const ready = gateway.connect();
    api.emit("nextValidId", 5000);
    await ready;
    expect(gateway.isConnected()).toBe(true);
    expect(gateway.allocateOrderId()).toBe(5000);
    expect(gateway.allocateOrderId()).toBe(5001);
    // Later nextValidId must not rewind the allocator.
    api.emit("nextValidId", 10);
    expect(gateway.allocateOrderId()).toBe(5002);
  });

  it("throws when allocating before ready", () => {
    const { gateway } = makeGateway();
    expect(() => gateway.allocateOrderId()).toThrow(/not ready/);
  });
});

describe("IbApiOrderGateway event normalization", () => {
  let api: FakeApi;
  let gateway: IbApiOrderGateway;
  beforeEach(async () => {
    ({ api, gateway } = makeGateway());
    const ready = gateway.connect();
    api.emit("nextValidId", 1);
    await ready;
  });

  it("normalizes orderStatus into a domain event", () => {
    const seen: unknown[] = [];
    gateway.on("orderStatus", (s) => seen.push(s));
    api.emit("orderStatus", 42, "Filled", 100, 0, 100.25, 0, 0, 0, "");
    expect(seen).toEqual([
      {
        orderId: 42,
        status: "Filled",
        filled: 100,
        remaining: 0,
        avgFillPrice: 100.25,
      },
    ]);
  });

  it("joins execDetails + commissionReport into one fill", () => {
    const fills: unknown[] = [];
    gateway.on("fill", (f) => fills.push(f));
    api.emit(
      "execDetails",
      1,
      { symbol: "QUAL" },
      {
        execId: "e-1",
        orderId: 42,
        side: "BOT",
        shares: 100,
        price: 100.1,
        time: "20260201  15:00:00",
      },
    );
    // No fill yet — commission half is still missing.
    expect(fills).toHaveLength(0);
    api.emit("commissionReport", { execId: "e-1", commission: 1.25 });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      execId: "e-1",
      orderId: 42,
      symbol: "QUAL",
      action: "buy",
      shares: 100,
      price: 100.1,
      commission: 1.25,
    });
  });

  it("maps a sell execution side to 'sell'", () => {
    const fills: Array<{ action: string }> = [];
    gateway.on("fill", (f) => fills.push(f as { action: string }));
    api.emit(
      "execDetails",
      1,
      { symbol: "QUAL" },
      {
        execId: "e-2",
        orderId: 7,
        side: "SLD",
        shares: 50,
        price: 99,
        time: "",
      },
    );
    api.emit("commissionReport", { execId: "e-2", commission: 0.5 });
    expect(fills[0]!.action).toBe("sell");
  });

  it("resolves fetchOpenOrders on openOrderEnd", async () => {
    const p = gateway.fetchOpenOrders();
    expect(api.reqOpenCalls).toBe(1);
    api.emit(
      "openOrder",
      42,
      { symbol: "QUAL" },
      { action: "BUY", totalQuantity: 100, orderType: "STP" },
      { status: "Submitted" },
    );
    api.emit("openOrderEnd");
    const orders = await p;
    expect(orders).toEqual([
      {
        orderId: 42,
        symbol: "QUAL",
        action: "BUY",
        totalQuantity: 100,
        orderType: "STP",
        status: "Submitted",
      },
    ]);
  });

  it("resolves fetchPositions on positionEnd", async () => {
    const p = gateway.fetchPositions();
    expect(api.reqPosCalls).toBe(1);
    api.emit("position", "DU1", { symbol: "QUAL" }, 100, 100.5);
    api.emit("positionEnd");
    const positions = await p;
    expect(positions).toEqual([
      { account: "DU1", symbol: "QUAL", position: 100, avgCost: 100.5 },
    ]);
  });

  it("resolves fetchNetLiquidation with the NetLiquidation tag on accountSummaryEnd", async () => {
    const p = gateway.fetchNetLiquidation();
    expect(api.reqAcctSummaryCalls).toBe(1);
    // Unrelated tags are ignored; only NetLiquidation feeds the result.
    api.emit("accountSummary", 9001, "DU1", "TotalCashValue", "50000", "USD");
    api.emit(
      "accountSummary",
      9001,
      "DU1",
      "NetLiquidation",
      "137500.42",
      "USD",
    );
    api.emit("accountSummaryEnd", 9001);
    await expect(p).resolves.toBe(137500.42);
    // The subscription is cancelled once the snapshot arrives.
    expect(api.cancelAcctSummaryCalls).toBe(1);
  });

  it("forwards placeOrder and cancelOrder to the IBApi", () => {
    const id = gateway.allocateOrderId();
    gateway.placeOrder(
      { symbol: "QUAL", secType: "STK", exchange: "SMART", currency: "USD" },
      {
        orderId: id,
        action: "BUY",
        totalQuantity: 1,
        orderType: "MKT",
        tif: "DAY",
        transmit: true,
      },
    );
    expect(api.placed[0]).toMatchObject({ orderId: id });
    gateway.cancelOrder(id);
    expect(api.cancelled).toEqual([id]);
  });
});
