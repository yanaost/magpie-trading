/**
 * MultiTargetExecutionPortProvider routing tests (T2.1): SIM → the shared
 * Simulator, PAPER → a lazily-built IbExecutionPort (no socket opened at
 * construction), LIVE → a hard LivePromotionLockedError (ground rule 6).
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { LivePromotionLockedError, Simulator } from "@magpie/core";
import type { AppConfig } from "../config/env.schema.js";
import { IbExecutionPort } from "./ib-execution-port.js";
import { MultiTargetExecutionPortProvider } from "./execution.module.js";
import type { IbOrderApi } from "./ib-order-gateway.js";

function makeProvider() {
  const simulator = new Simulator();
  const config = {
    IB_GATEWAY_HOST: "localhost",
    IB_GATEWAY_PORT: 4002,
    IB_CLIENT_ID: 10,
  } as unknown as AppConfig;
  // A factory that returns a never-connecting stub; PAPER routing must not
  // require it at construction time.
  const factory = vi.fn(() => new EventEmitter() as unknown as IbOrderApi);
  const provider = new MultiTargetExecutionPortProvider(
    simulator,
    config,
    factory,
  );
  return { provider, simulator, factory };
}

describe("MultiTargetExecutionPortProvider", () => {
  it("routes SIM to the shared Simulator", () => {
    const { provider, simulator } = makeProvider();
    expect(provider.portFor("SIM")).toBe(simulator);
  });

  it("routes PAPER to a lazily-built IbExecutionPort and caches it", () => {
    const { provider, factory } = makeProvider();
    const a = provider.portFor("PAPER");
    const b = provider.portFor("PAPER");
    expect(a).toBeInstanceOf(IbExecutionPort);
    expect(a).toBe(b);
    // Building the port opens no socket — the client factory is untouched
    // until the gateway actually connects on first order.
    expect(factory).not.toHaveBeenCalled();
  });

  it("locks LIVE behind LivePromotionLockedError", () => {
    const { provider } = makeProvider();
    expect(() => provider.portFor("LIVE")).toThrow(LivePromotionLockedError);
  });
});
