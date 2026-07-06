import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger, type OnModuleInit } from "@nestjs/common";
import { Queue, type Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import { WorkerHeartbeat } from "../uptime/worker-heartbeat.js";

export const DEMO_QUEUE = "demo";
const SCHEDULER_ID = "demo-heartbeat";

/**
 * Phase 0 heartbeat processor: proves the BullMQ scheduler → worker path works
 * end-to-end. Logs on every tick (default every 30s, TASKS T0.4 AC).
 */
@Processor(DEMO_QUEUE)
export class DemoProcessor extends WorkerHost {
  private readonly logger = new Logger("DemoProcessor");

  constructor(private readonly heartbeat: WorkerHeartbeat) {
    super();
  }

  override async process(job: Job): Promise<void> {
    this.logger.log(`demo heartbeat tick (job ${job.id}) — worker alive`);
    // Bump the shared liveness key the uptime monitor watches (T3.6).
    await this.heartbeat.beat();
  }
}

/**
 * Registers the repeatable heartbeat job on startup. Idempotent
 * (`upsertJobScheduler`), and resilient to Redis being down at boot.
 */
export class DemoScheduler implements OnModuleInit {
  private readonly logger = new Logger("DemoScheduler");

  constructor(
    @InjectQueue(DEMO_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    const every = this.config.DEMO_JOB_INTERVAL_MS;
    try {
      await this.queue.upsertJobScheduler(
        SCHEDULER_ID,
        { every },
        { name: "tick" },
      );
      this.logger.log(`demo heartbeat scheduled every ${every}ms`);
    } catch (err) {
      this.logger.warn(
        `could not schedule demo heartbeat (redis down?): ${(err as Error).message}`,
      );
    }
  }
}
