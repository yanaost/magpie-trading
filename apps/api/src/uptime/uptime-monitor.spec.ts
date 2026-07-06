/**
 * Uptime monitor tests (T3.6). Drives the real {@link UptimeMonitorService}
 * against a scripted probe + spy sink to prove the edge-triggered alerting the
 * AC needs: "alert fires when the gateway container is stopped" — once on the
 * stop, not every tick, and a recovery message when it comes back.
 */
import { describe, expect, it } from "vitest";
import { UptimeMonitorService } from "./uptime-monitor.service.js";
import type { UptimeProbe } from "./uptime.probe.js";
import type {
  AlertEvent,
  AlertSink,
  UptimeSnapshot,
  UptimeThresholds,
} from "./uptime.types.js";

const THRESHOLDS: UptimeThresholds = {
  workerStaleMs: 90_000,
  queueBacklogMax: 100,
};

/** A probe that returns whatever snapshot is currently set. */
class ScriptedProbe implements UptimeProbe {
  constructor(public snap: UptimeSnapshot) {}
  async snapshot(): Promise<UptimeSnapshot> {
    return this.snap;
  }
}

/** Records every delivered event. */
class SpySink implements AlertSink {
  readonly events: AlertEvent[] = [];
  async deliver(event: AlertEvent): Promise<void> {
    this.events.push(event);
  }
}

const HEALTHY: UptimeSnapshot = {
  gateway: "up",
  workerHeartbeatAgeMs: 1_000,
  queueDepth: 0,
};

describe("UptimeMonitorService", () => {
  it("fires once when the gateway goes down, then recovers", async () => {
    const probe = new ScriptedProbe(HEALTHY);
    const sink = new SpySink();
    const monitor = new UptimeMonitorService(probe, sink, THRESHOLDS);

    // Healthy tick — no alert.
    await monitor.tick();
    expect(sink.events).toHaveLength(0);
    expect(monitor.firing).toEqual([]);

    // Gateway container stopped → TCP probe down.
    probe.snap = { ...HEALTHY, gateway: "down" };
    await monitor.tick();
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      kind: "gateway-down",
      state: "firing",
    });
    expect(monitor.firing).toEqual(["gateway-down"]);

    // Still down on the next tick → NO duplicate alert (edge-triggered).
    await monitor.tick();
    expect(sink.events).toHaveLength(1);

    // Gateway back → exactly one recovery event.
    probe.snap = HEALTHY;
    await monitor.tick();
    expect(sink.events).toHaveLength(2);
    expect(sink.events[1]).toMatchObject({
      kind: "gateway-down",
      state: "recovered",
    });
    expect(monitor.firing).toEqual([]);
  });

  it("fires worker-stalled and queue-backlog independently", async () => {
    const probe = new ScriptedProbe(HEALTHY);
    const sink = new SpySink();
    const monitor = new UptimeMonitorService(probe, sink, THRESHOLDS);
    await monitor.tick(); // establish heartbeatSeen + healthy baseline

    probe.snap = {
      gateway: "up",
      workerHeartbeatAgeMs: 120_000, // > 90s stale
      queueDepth: 250, // > 100 backlog
    };
    await monitor.tick();

    const kinds = sink.events
      .filter((e) => e.state === "firing")
      .map((e) => e.kind);
    expect(kinds).toContain("worker-stalled");
    expect(kinds).toContain("queue-backlog");
    expect(monitor.firing.slice().sort()).toEqual([
      "queue-backlog",
      "worker-stalled",
    ]);
  });

  it("does not flag a missing heartbeat before one has ever been seen", async () => {
    // First observation is a null heartbeat (fresh boot) → not stalled yet.
    const probe = new ScriptedProbe({
      gateway: "up",
      workerHeartbeatAgeMs: null,
      queueDepth: 0,
    });
    const sink = new SpySink();
    const monitor = new UptimeMonitorService(probe, sink, THRESHOLDS);

    await monitor.tick();
    expect(monitor.firing).toEqual([]);
    expect(sink.events).toHaveLength(0);

    // A heartbeat lands, then the worker dies (null again) → now it's stalled.
    probe.snap = { gateway: "up", workerHeartbeatAgeMs: 2_000, queueDepth: 0 };
    await monitor.tick();
    probe.snap = { gateway: "up", workerHeartbeatAgeMs: null, queueDepth: 0 };
    await monitor.tick();
    expect(monitor.firing).toEqual(["worker-stalled"]);
  });

  it("survives a probe failure without crashing the loop", async () => {
    const sink = new SpySink();
    const probe: UptimeProbe = {
      async snapshot() {
        throw new Error("redis exploded");
      },
    };
    const monitor = new UptimeMonitorService(probe, sink, THRESHOLDS);
    await expect(monitor.tick()).resolves.toBeUndefined();
    expect(sink.events).toHaveLength(0);
  });
});
