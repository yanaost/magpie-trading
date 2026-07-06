/**
 * Reconciliation unit tests (T2.1 AC): the diff must detect a manually-placed
 * rogue order and a rogue position, flag missing/drifted state, and report clean
 * when broker truth matches our books.
 */
import { describe, expect, it } from "vitest";
import type { BrokerOpenOrder, BrokerPosition } from "./ib-order-gateway.js";
import { reconcile, type KnownState } from "./ib-reconciliation.js";

const order = (
  o: Partial<BrokerOpenOrder> & { orderId: number },
): BrokerOpenOrder => ({
  symbol: "QUAL",
  action: "BUY",
  totalQuantity: 100,
  orderType: "STP",
  status: "Submitted",
  ...o,
});
const pos = (symbol: string, position: number): BrokerPosition => ({
  account: "DU123",
  symbol,
  position,
  avgCost: 100,
});

describe("reconcile", () => {
  it("reports clean when broker truth matches our books", () => {
    const known: KnownState = {
      knownOrderIds: new Set([1, 2]),
      knownPositions: new Map([["QUAL", 100]]),
    };
    const out = reconcile(
      [order({ orderId: 1 }), order({ orderId: 2 })],
      [pos("QUAL", 100)],
      known,
    );
    expect(out).toEqual([]);
  });

  it("detects a manually-placed rogue order", () => {
    const known: KnownState = {
      knownOrderIds: new Set([1]),
      knownPositions: new Map(),
    };
    const out = reconcile(
      [order({ orderId: 1 }), order({ orderId: 999 })],
      [],
      known,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "rogue_order", orderId: 999 });
  });

  it("detects a missing order we believe is working", () => {
    const known: KnownState = {
      knownOrderIds: new Set([1, 2]),
      knownPositions: new Map(),
    };
    const out = reconcile([order({ orderId: 1 })], [], known);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "missing_order", orderId: 2 });
  });

  it("detects a rogue position we never opened", () => {
    const known: KnownState = {
      knownOrderIds: new Set(),
      knownPositions: new Map(),
    };
    const out = reconcile([], [pos("ROGUE", -50)], known);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "rogue_position",
      ticker: "ROGUE",
      actual: -50,
    });
  });

  it("detects a quantity drift against our expected position", () => {
    const known: KnownState = {
      knownOrderIds: new Set(),
      knownPositions: new Map([["QUAL", 100]]),
    };
    const out = reconcile([], [pos("QUAL", 60)], known);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "position_drift",
      ticker: "QUAL",
      expected: 100,
      actual: 60,
    });
  });

  it("flags a position we expect but the broker reports flat", () => {
    const known: KnownState = {
      knownOrderIds: new Set(),
      knownPositions: new Map([["QUAL", 100]]),
    };
    const out = reconcile([], [pos("QUAL", 0)], known);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "position_drift",
      expected: 100,
      actual: 0,
    });
  });
});
