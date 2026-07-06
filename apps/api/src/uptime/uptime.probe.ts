/**
 * Uptime probe (T3.6) — assembles a live {@link UptimeSnapshot} from the pieces
 * already in the app: {@link HealthService} for gateway reachability, the BullMQ
 * queue for backlog depth, and {@link WorkerHeartbeat} for worker liveness.
 *
 * Behind the {@link UptimeProbe} interface so the monitor service can be unit-
 * tested against a scripted snapshot with no infra.
 */
import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { HealthService } from "../health/health.service.js";
import { DEMO_QUEUE } from "../queue/demo.processor.js";
import { WorkerHeartbeat } from "./worker-heartbeat.js";
import type { UptimeSnapshot } from "./uptime.types.js";

/** Source of point-in-time uptime readings. */
export interface UptimeProbe {
  snapshot(): Promise<UptimeSnapshot>;
}

@Injectable()
export class LiveUptimeProbe implements UptimeProbe {
  private readonly logger = new Logger(LiveUptimeProbe.name);

  constructor(
    private readonly health: HealthService,
    private readonly heartbeat: WorkerHeartbeat,
    @InjectQueue(DEMO_QUEUE) private readonly queue: Queue,
  ) {}

  async snapshot(): Promise<UptimeSnapshot> {
    const [health, workerHeartbeatAgeMs, queueDepth] = await Promise.all([
      this.health.check(),
      this.heartbeat.ageMs(),
      this.queueDepth(),
    ]);
    return { gateway: health.deps.gateway, workerHeartbeatAgeMs, queueDepth };
  }

  /** Waiting + delayed jobs; 0 (not an alert) if the count can't be read. */
  private async queueDepth(): Promise<number> {
    try {
      const counts = await this.queue.getJobCounts("wait", "delayed");
      return (counts.wait ?? 0) + (counts.delayed ?? 0);
    } catch (err) {
      this.logger.warn(`queue depth probe failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
