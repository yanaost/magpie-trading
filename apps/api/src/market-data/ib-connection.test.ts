import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IbConnection,
  type IbClient,
  type TimerHandle,
} from "./ib-connection.js";

/** A fake IBApi: an EventEmitter with spy'd request/connect methods. */
class FakeClient extends EventEmitter implements IbClient {
  connect = vi.fn((_clientId?: number) => this);
  disconnect = vi.fn(() => this);
  reqHistoricalData = vi.fn(() => this);
  reqRealTimeBars = vi.fn(() => this);
  cancelRealTimeBars = vi.fn(() => this);
  // `on`/`removeAllListeners` inherited from EventEmitter satisfy IbClient.
}

/** Controllable timer harness so backoff scheduling is deterministic. */
function timerHarness() {
  const scheduled: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    scheduled,
    setTimer: (fn: () => void, ms: number): TimerHandle => {
      scheduled.push({ fn, ms, cleared: false });
      return (scheduled.length - 1) as unknown as TimerHandle;
    },
    clearTimer: (h: TimerHandle): void => {
      const i = h as unknown as number;
      if (scheduled[i]) scheduled[i]!.cleared = true;
    },
    fire: (i: number): void => {
      const t = scheduled[i];
      if (t && !t.cleared) t.fn();
    },
  };
}

const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("IbConnection", () => {
  let clients: FakeClient[];
  let timers: ReturnType<typeof timerHarness>;
  let conn: IbConnection;

  beforeEach(() => {
    clients = [];
    timers = timerHarness();
    conn = new IbConnection({
      host: "127.0.0.1",
      port: 4002,
      clientId: 10,
      baseReconnectMs: 1_000,
      maxReconnectMs: 30_000,
      factory: () => {
        const c = new FakeClient();
        clients.push(c);
        return c;
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      logger: silentLogger,
    });
  });

  it("connects and reports connected state + emits connected", () => {
    const onConnected = vi.fn();
    conn.on("connected", onConnected);
    conn.start();

    expect(clients).toHaveLength(1);
    expect(clients[0]!.connect).toHaveBeenCalledWith(10);
    expect(conn.isConnected()).toBe(false);

    clients[0]!.emit("connected");
    expect(conn.isConnected()).toBe(true);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("reconnects with exponential backoff after an unexpected disconnect", () => {
    conn.start();
    clients[0]!.emit("connected");

    // First drop → schedule reconnect at base delay.
    clients[0]!.emit("disconnected");
    expect(conn.isConnected()).toBe(false);
    expect(timers.scheduled).toHaveLength(1);
    expect(timers.scheduled[0]!.ms).toBe(1_000);

    // Fire the timer → a fresh client is created and connect() called again.
    timers.fire(0);
    expect(clients).toHaveLength(2);
    expect(clients[1]!.connect).toHaveBeenCalled();

    // Second drop (still not reconnected) → next backoff doubles to 2000.
    clients[1]!.emit("disconnected");
    expect(timers.scheduled).toHaveLength(2);
    expect(timers.scheduled[1]!.ms).toBe(2_000);
  });

  it("resets backoff after a successful reconnect", () => {
    conn.start();
    clients[0]!.emit("connected");

    clients[0]!.emit("disconnected");
    expect(timers.scheduled[0]!.ms).toBe(1_000);
    timers.fire(0);
    clients[1]!.emit("connected"); // success resets attempts

    clients[1]!.emit("disconnected");
    expect(timers.scheduled[1]!.ms).toBe(1_000); // back to base, not 2000
  });

  it("stop() prevents any further reconnect", () => {
    conn.start();
    clients[0]!.emit("connected");
    conn.stop();

    clients[0]!.emit("disconnected");
    // No new timer scheduled; no new client created.
    expect(timers.scheduled).toHaveLength(0);
    expect(clients).toHaveLength(1);
    expect(conn.isConnected()).toBe(false);
  });

  it("routes historical + realtime bars through normalized events", () => {
    const onHist = vi.fn();
    const onEnd = vi.fn();
    const onRt = vi.fn();
    conn.on("historicalData", onHist);
    conn.on("historicalEnd", onEnd);
    conn.on("realtimeBar", onRt);
    conn.start();
    clients[0]!.emit("connected");

    clients[0]!.emit(
      "historicalData",
      7,
      "20240705",
      170.8,
      172.0,
      170.5,
      171.9,
      18110,
      900,
      171.2,
      false,
    );
    expect(onHist).toHaveBeenCalledWith(7, {
      date: "20240705",
      open: 170.8,
      high: 172.0,
      low: 170.5,
      close: 171.9,
      volume: 18110,
    });

    clients[0]!.emit(
      "historicalData",
      7,
      "finished-x",
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      -1,
      false,
    );
    expect(onEnd).toHaveBeenCalledWith(7);

    clients[0]!.emit(
      "realtimeBar",
      9,
      1720190100,
      553.1,
      553.3,
      553.0,
      553.25,
      4200,
      553.2,
      12,
    );
    expect(onRt).toHaveBeenCalledWith(9, {
      time: 1720190100,
      open: 553.1,
      high: 553.3,
      low: 553.0,
      close: 553.25,
      volume: 4200,
    });
  });
});
