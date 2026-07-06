/**
 * IbExecutionPort unit tests (T2.1). Drive the port against a fake gateway (an
 * EventEmitter with recording stubs) so the whole bracket lifecycle — stage,
 * fill, close, modify, cancel — is exercised without a live paper gateway.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import { LivePromotionLockedError } from "@magpie/core";
import type {
  BrokerOpenOrder,
  BrokerOrderSpec,
  BrokerPosition,
  EquityContract,
  IbOrderGateway,
} from "./ib-order-gateway.js";
import { IbExecutionPort, mapIbStatus } from "./ib-execution-port.js";

class FakeGateway extends EventEmitter implements IbOrderGateway {
  connected = true;
  private id = 1000;
  readonly placed: Array<{ contract: EquityContract; order: BrokerOrderSpec }> =
    [];
  readonly cancelled: number[] = [];
  openOrders: BrokerOpenOrder[] = [];
  positions: BrokerPosition[] = [];

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }
  disconnect(): void {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  allocateOrderId(): number {
    this.id += 1;
    return this.id;
  }
  placeOrder(contract: EquityContract, order: BrokerOrderSpec): void {
    this.placed.push({ contract, order });
  }
  cancelOrder(orderId: number): void {
    this.cancelled.push(orderId);
  }
  fetchOpenOrders(): Promise<BrokerOpenOrder[]> {
    return Promise.resolve(this.openOrders);
  }
  fetchPositions(): Promise<BrokerPosition[]> {
    return Promise.resolve(this.positions);
  }
}

const longBracket = {
  strategyId: "qual-sphb",
  target: "PAPER" as const,
  ticker: "QUAL",
  side: "long" as const,
  qty: 100,
  entryType: "market" as const,
  stopPrice: 92,
  targetPrice: 120,
  timeInForce: "DAY" as const,
};

describe("IbExecutionPort.placeBracket", () => {
  let gw: FakeGateway;
  let port: IbExecutionPort;
  beforeEach(() => {
    gw = new FakeGateway();
    port = new IbExecutionPort(gw);
  });

  it("stages parent + stop + target as an OCA group, only the last transmits", async () => {
    const handle = await port.placeBracket(longBracket);
    expect(gw.placed).toHaveLength(3);
    const parent = gw.placed[0]!.order;
    const stop = gw.placed[1]!.order;
    const target = gw.placed[2]!.order;
    expect(parent).toMatchObject({
      action: "BUY",
      orderType: "MKT",
      transmit: false,
    });
    expect(stop).toMatchObject({
      action: "SELL",
      orderType: "STP",
      auxPrice: 92,
      parentId: parent.orderId,
      transmit: false,
    });
    expect(target).toMatchObject({
      action: "SELL",
      orderType: "LMT",
      lmtPrice: 120,
      parentId: parent.orderId,
      transmit: true,
    });
    expect(handle.parent.role).toBe("parent");
    expect(handle.target?.limitPrice).toBe(120);
  });

  it("transmits the stop when there is no take-profit leg", async () => {
    await port.placeBracket({ ...longBracket, targetPrice: undefined });
    expect(gw.placed).toHaveLength(2);
    expect(gw.placed[1]!.order).toMatchObject({
      orderType: "STP",
      transmit: true,
    });
  });

  it("throws LivePromotionLockedError for a LIVE target", async () => {
    await expect(
      port.placeBracket({ ...longBracket, target: "LIVE" }),
    ).rejects.toBeInstanceOf(LivePromotionLockedError);
  });
});

describe("IbExecutionPort fill lifecycle", () => {
  let gw: FakeGateway;
  let port: IbExecutionPort;
  beforeEach(async () => {
    gw = new FakeGateway();
    port = new IbExecutionPort(gw);
    await port.start();
  });

  async function place() {
    const handle = await port.placeBracket(longBracket);
    const parentId = Number(handle.parent.orderId);
    const stopId = Number(handle.stop.orderId);
    return { handle, parentId, stopId };
  }

  it("opens an attributed position when the parent fills", async () => {
    const { parentId } = await place();
    gw.emit("orderStatus", {
      orderId: parentId,
      status: "Filled",
      filled: 100,
      remaining: 0,
      avgFillPrice: 100.1,
    });
    const positions = await port.getPositions("qual-sphb");
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      strategyId: "qual-sphb",
      ticker: "QUAL",
      side: "long",
      qty: 100,
      avgEntryPrice: 100.1,
      stopPrice: 92,
    });
    expect(await port.getPositions("other")).toHaveLength(0);
  });

  it("records a fill with commission from the exec/commission pair", async () => {
    const { parentId } = await place();
    port["onFill"]({
      execId: "e-1",
      orderId: parentId,
      symbol: "QUAL",
      action: "buy",
      shares: 100,
      price: 100.05,
      commission: 1.0,
      time: new Date("2026-02-01T15:00:00Z"),
    });
    const fills = await port.getFills();
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      ticker: "QUAL",
      qty: 100,
      price: 100.05,
      commission: 1.0,
      brokerExecId: "e-1",
    });
  });

  it("closes the bracket when a protective leg fills (OCA)", async () => {
    const { parentId, stopId } = await place();
    gw.emit("orderStatus", {
      orderId: parentId,
      status: "Filled",
      filled: 100,
      remaining: 0,
      avgFillPrice: 100,
    });
    gw.emit("orderStatus", {
      orderId: stopId,
      status: "Filled",
      filled: 100,
      remaining: 0,
      avgFillPrice: 92,
    });
    expect(await port.getPositions()).toHaveLength(0);
  });
});

describe("IbExecutionPort modify + cancel", () => {
  let gw: FakeGateway;
  let port: IbExecutionPort;
  beforeEach(async () => {
    gw = new FakeGateway();
    port = new IbExecutionPort(gw);
    await port.start();
  });

  it("re-places the stop leg to tighten it", async () => {
    const handle = await port.placeBracket(longBracket);
    gw.placed.length = 0;
    await port.modifyBracket({ bracketId: handle.bracketId, newStopPrice: 95 });
    expect(gw.placed).toHaveLength(1);
    expect(gw.placed[0]!.order).toMatchObject({
      orderId: Number(handle.stop.orderId),
      orderType: "STP",
      auxPrice: 95,
    });
  });

  it("rejects an upward qty modification (no averaging up)", async () => {
    const handle = await port.placeBracket(longBracket);
    await expect(
      port.modifyBracket({ bracketId: handle.bracketId, newQty: 150 }),
    ).rejects.toThrow(/Downward-only/);
  });

  it("cancels every leg of the bracket", async () => {
    const handle = await port.placeBracket(longBracket);
    await port.cancelBracket(handle.bracketId);
    expect(gw.cancelled).toEqual([
      Number(handle.parent.orderId),
      Number(handle.stop.orderId),
      Number(handle.target!.orderId),
    ]);
  });
});

describe("mapIbStatus", () => {
  it("maps IB statuses onto our order lifecycle", () => {
    expect(mapIbStatus("PendingSubmit")).toBe("pending_submit");
    expect(mapIbStatus("PreSubmitted")).toBe("submitted");
    expect(mapIbStatus("Submitted")).toBe("working");
    expect(mapIbStatus("Filled")).toBe("filled");
    expect(mapIbStatus("Cancelled")).toBe("cancelled");
    expect(mapIbStatus("Inactive")).toBe("rejected");
  });
});
