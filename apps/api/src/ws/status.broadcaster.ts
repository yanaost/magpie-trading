import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import { HealthService } from "../health/health.service.js";
import { EventsGateway } from "./events.gateway.js";

/**
 * Periodically pushes the `/healthz` report to connected dashboards over the
 * WebSocket `health` channel, so the UI reflects live system status without
 * polling (T0.6 AC: "page reflects live /healthz over WebSocket").
 */
@Injectable()
export class StatusBroadcaster implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("StatusBroadcaster");
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly health: HealthService,
    private readonly gateway: EventsGateway,
  ) {}

  onModuleInit(): void {
    const intervalMs = Math.max(1_000, this.config.HEALTH_BROADCAST_MS);
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Emit once promptly so a freshly-connected client isn't blank.
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    try {
      const report = await this.health.check();
      this.gateway.emitHealth(report);
    } catch (err) {
      this.logger.warn(`health broadcast failed: ${String(err)}`);
    }
  }
}
