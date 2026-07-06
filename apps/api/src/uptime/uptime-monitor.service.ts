/**
 * Uptime monitor (T3.6). On each {@link tick} it takes an {@link UptimeSnapshot},
 * evaluates the active alerts, diffs them against the alerts already firing, and
 * delivers only the *edges* (a new outage → one alert; its recovery → one
 * recovery message). Persistent outages therefore notify once, not every tick —
 * the property the AC's "alert fires when gateway container is stopped" relies on
 * (fire exactly once on the stop, once again on restart).
 *
 * The state (which alerts are currently firing, whether a heartbeat has ever
 * been seen) lives here, not in the probe — so this class is the whole testable
 * surface and the probe/sink stay dumb.
 */
import { Injectable, Logger } from "@nestjs/common";
import {
  diffAlerts,
  evaluateAlerts,
  type AlertKind,
  type AlertSink,
  type UptimeThresholds,
} from "./uptime.types.js";
import type { UptimeProbe } from "./uptime.probe.js";

@Injectable()
export class UptimeMonitorService {
  private readonly logger = new Logger(UptimeMonitorService.name);
  private active = new Set<AlertKind>();
  private heartbeatSeen = false;

  constructor(
    private readonly probe: UptimeProbe,
    private readonly sink: AlertSink,
    private readonly thresholds: UptimeThresholds,
  ) {}

  /** Currently-firing alerts (for tests / a status endpoint). */
  get firing(): readonly AlertKind[] {
    return [...this.active];
  }

  /**
   * One monitoring cycle. Never throws — a probe or sink failure is logged and
   * the loop continues (a monitor that dies on the first hiccup is worse than
   * useless). Returns the edge events delivered this tick (for tests).
   */
  async tick(): Promise<void> {
    let snapshot;
    try {
      snapshot = await this.probe.snapshot();
    } catch (err) {
      this.logger.warn(`uptime probe failed: ${(err as Error).message}`);
      return;
    }

    // Once a real heartbeat lands, a subsequent null means the worker died —
    // only then should a null age count as stalled.
    if (snapshot.workerHeartbeatAgeMs !== null) this.heartbeatSeen = true;

    const current = evaluateAlerts(
      snapshot,
      this.thresholds,
      this.heartbeatSeen,
    );
    const events = diffAlerts(this.active, current);

    for (const event of events) {
      this.logger.warn(
        `uptime ${event.state}: ${event.kind} — ${event.detail}`,
      );
      try {
        await this.sink.deliver(event);
      } catch (err) {
        this.logger.warn(
          `alert delivery failed (${event.kind}): ${(err as Error).message}`,
        );
      }
    }

    this.active = new Set(current.keys());
  }
}
