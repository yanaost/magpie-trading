/**
 * Uptime alerting (T3.6) — pure types + the alert-evaluation function. Kept
 * framework-free and side-effect-free so the fire/dedupe/recovery logic is
 * unit-testable without Nest, Redis, or the network.
 *
 * The monitor watches three failure modes the spec calls out (§6 observability):
 *
 *   - `gateway-down`  — the IB gateway TCP port is unreachable;
 *   - `worker-stalled` — no BullMQ worker heartbeat within the stale window;
 *   - `queue-backlog`  — waiting+delayed jobs exceed the backlog threshold.
 *
 * Alerts are edge-triggered: {@link diffAlerts} compares the newly-evaluated set
 * against the currently-active set, so a persistent outage notifies once (on the
 * way in) and once on recovery — never every tick.
 */
import type { DepStatus } from "../health/health.service.js";

/** The three watched failure modes. */
export type AlertKind = "gateway-down" | "worker-stalled" | "queue-backlog";

export const ALL_ALERT_KINDS: readonly AlertKind[] = [
  "gateway-down",
  "worker-stalled",
  "queue-backlog",
];

/** A single point-in-time reading of the things the monitor watches. */
export interface UptimeSnapshot {
  readonly gateway: DepStatus;
  /**
   * Age of the most recent worker heartbeat, in ms. `null` means "no heartbeat
   * ever seen / unknown" — treated as stalled once the monitor has had time to
   * observe at least one interval (see {@link UptimeMonitorService}).
   */
  readonly workerHeartbeatAgeMs: number | null;
  /** Waiting + delayed jobs across monitored queues. */
  readonly queueDepth: number;
}

/** Alerting thresholds (from config). */
export interface UptimeThresholds {
  readonly workerStaleMs: number;
  readonly queueBacklogMax: number;
}

/** A fired alert (or its recovery), ready to render to a sink. */
export interface AlertEvent {
  readonly kind: AlertKind;
  readonly state: "firing" | "recovered";
  readonly detail: string;
}

/** Anywhere an alert can be delivered (Telegram, WS, a test spy). */
export interface AlertSink {
  deliver(event: AlertEvent): Promise<void>;
}

/**
 * Evaluate which alerts are *currently* active for a snapshot. Pure: returns the
 * active set + a human detail per kind, no memory of prior calls.
 *
 * A `null` heartbeat age is only treated as stalled when `heartbeatSeen` is
 * true — i.e. the monitor has run long enough to expect a beat. This avoids a
 * spurious "worker stalled" alert during the first interval after boot.
 */
export function evaluateAlerts(
  snapshot: UptimeSnapshot,
  thresholds: UptimeThresholds,
  heartbeatSeen: boolean,
): Map<AlertKind, string> {
  const active = new Map<AlertKind, string>();

  if (snapshot.gateway === "down") {
    active.set("gateway-down", "IB gateway is unreachable (TCP probe failed).");
  }

  const age = snapshot.workerHeartbeatAgeMs;
  if (age === null) {
    if (heartbeatSeen) {
      active.set(
        "worker-stalled",
        "No worker heartbeat has ever been recorded.",
      );
    }
  } else if (age > thresholds.workerStaleMs) {
    active.set(
      "worker-stalled",
      `No worker heartbeat for ${Math.round(age / 1000)}s ` +
        `(threshold ${Math.round(thresholds.workerStaleMs / 1000)}s).`,
    );
  }

  if (snapshot.queueDepth > thresholds.queueBacklogMax) {
    active.set(
      "queue-backlog",
      `Queue backlog is ${snapshot.queueDepth} jobs ` +
        `(threshold ${thresholds.queueBacklogMax}).`,
    );
  }

  return active;
}

/**
 * Diff a freshly-evaluated active set against the previously-active set into the
 * edge events to deliver: newly-present kinds fire, newly-absent kinds recover.
 */
export function diffAlerts(
  previous: ReadonlySet<AlertKind>,
  current: ReadonlyMap<AlertKind, string>,
): AlertEvent[] {
  const events: AlertEvent[] = [];
  for (const [kind, detail] of current) {
    if (!previous.has(kind)) {
      events.push({ kind, state: "firing", detail });
    }
  }
  for (const kind of previous) {
    if (!current.has(kind)) {
      events.push({
        kind,
        state: "recovered",
        detail: `${kind} has recovered.`,
      });
    }
  }
  return events;
}

/** Render an alert event to Telegram-flavoured HTML. */
export function renderAlert(event: AlertEvent): string {
  const icon = event.state === "firing" ? "🔴" : "🟢";
  const label = event.state === "firing" ? "ALERT" : "RECOVERED";
  return `${icon} <b>${label}: ${event.kind}</b>\n${event.detail}`;
}
