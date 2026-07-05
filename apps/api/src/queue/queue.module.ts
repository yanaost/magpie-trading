import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import { DemoProcessor, DemoScheduler, DEMO_QUEUE } from "./demo.processor.js";

/**
 * BullMQ wiring. One shared Redis connection (parsed from `REDIS_URL`) drives
 * all queues/workers. Registers the `demo` queue used by the Phase 0 heartbeat.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
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
    }),
    BullModule.registerQueue({ name: DEMO_QUEUE }),
  ],
  providers: [DemoProcessor, DemoScheduler],
})
export class QueueModule {}
