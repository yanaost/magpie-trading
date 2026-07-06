import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import { WorkerHeartbeat } from "../uptime/worker-heartbeat.js";
import { DemoProcessor, DemoScheduler, DEMO_QUEUE } from "./demo.processor.js";

/**
 * The shared BullMQ root: one Redis connection (parsed from `REDIS_URL`) drives
 * all queues/workers. Exported so feature modules can `registerQueue` their own
 * queues against the same connection without re-declaring `forRoot`.
 */
export const BullRootModule = BullModule.forRootAsync({
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig) => {
    const url = new URL(config.REDIS_URL);
    return {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        // BullMQ workers require this to be null for blocking commands.
        maxRetriesPerRequest: null,
      },
    };
  },
});

/**
 * BullMQ wiring. Registers the `demo` queue used by the Phase 0 heartbeat and
 * re-exports the shared Bull root so other modules can attach queues to it.
 */
@Module({
  imports: [BullRootModule, BullModule.registerQueue({ name: DEMO_QUEUE })],
  providers: [DemoProcessor, DemoScheduler, WorkerHeartbeat],
  exports: [BullRootModule, WorkerHeartbeat],
})
export class QueueModule {}
