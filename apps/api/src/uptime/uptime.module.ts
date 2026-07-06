/**
 * Uptime monitoring module (T3.6). Wires the live probe (health + queue depth +
 * worker heartbeat), the Telegram alert sink, and the monitor loop that fires
 * edge-triggered alerts. The whole feature is gated on `UPTIME_MONITOR_ENABLED`:
 * when off (default — dev/CI/SIM), the scheduler simply never arms, so nothing
 * probes or pages.
 */
import {
  Module,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import { HealthModule } from "../health/health.module.js";
import { QueueModule } from "../queue/queue.module.js";
import { DEMO_QUEUE } from "../queue/demo.processor.js";
import { TelegramModule } from "../telegram/telegram.module.js";
import { LiveUptimeProbe } from "./uptime.probe.js";
import { TelegramAlertSink } from "./telegram-alert-sink.js";
import { UptimeMonitorService } from "./uptime-monitor.service.js";
import type { UptimeThresholds } from "./uptime.types.js";

/** DI token for the assembled monitor (built via factory to inject thresholds). */
export const UPTIME_MONITOR = Symbol("UPTIME_MONITOR");

/**
 * Arms the monitor loop on boot when enabled, and clears it on shutdown. The
 * loop is a plain interval (simplest thing that works); each tick is guarded
 * inside {@link UptimeMonitorService.tick} so a slow/failed probe never stacks.
 */
class UptimeScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UptimeScheduler.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly monitor: UptimeMonitorService,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.UPTIME_MONITOR_ENABLED) {
      this.logger.log("uptime monitor disabled (UPTIME_MONITOR_ENABLED=false)");
      return;
    }
    const every = this.config.UPTIME_CHECK_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.monitor.tick();
    }, every);
    // Don't hold the event loop open on shutdown.
    this.timer.unref?.();
    this.logger.log(`uptime monitor armed, probing every ${every}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

@Module({
  imports: [
    HealthModule,
    QueueModule,
    TelegramModule,
    BullModule.registerQueue({ name: DEMO_QUEUE }),
  ],
  providers: [
    LiveUptimeProbe,
    TelegramAlertSink,
    {
      provide: UPTIME_MONITOR,
      inject: [LiveUptimeProbe, TelegramAlertSink, APP_CONFIG],
      useFactory: (
        probe: LiveUptimeProbe,
        sink: TelegramAlertSink,
        config: AppConfig,
      ): UptimeMonitorService => {
        const thresholds: UptimeThresholds = {
          workerStaleMs: config.UPTIME_WORKER_STALE_MS,
          queueBacklogMax: config.UPTIME_QUEUE_BACKLOG_MAX,
        };
        return new UptimeMonitorService(probe, sink, thresholds);
      },
    },
    {
      provide: UptimeScheduler,
      inject: [UPTIME_MONITOR, APP_CONFIG],
      useFactory: (monitor: UptimeMonitorService, config: AppConfig) =>
        new UptimeScheduler(monitor, config),
    },
  ],
  exports: [UPTIME_MONITOR],
})
export class UptimeModule {}
