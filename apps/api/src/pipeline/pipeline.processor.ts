/**
 * BullMQ driver for the signal pipeline (T1.6). Three repeatable jobs fan the
 * scheduler ticks into the orchestrator:
 *   - `scan`    — run every order-capable strategy's scan → mode gate
 *   - `monitor` — run each strategy's position monitor (Strategy.manage)
 *   - `expiry`  — sweep pending proposals past their TTL
 *
 * The worker resolves runtimes from the registry each tick, so mode/target
 * changes take effect without a redeploy. Jobs are resilient to Redis being
 * down at boot (the scheduler logs and continues, matching the demo heartbeat).
 */
import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger, type OnModuleInit } from "@nestjs/common";
import { Queue, type Job } from "bullmq";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import { PipelineService } from "./pipeline.service.js";
import { STRATEGY_REGISTRY, type StrategyRegistry } from "./pipeline.types.js";

export const PIPELINE_QUEUE = "pipeline";

type PipelineJobName = "scan" | "monitor" | "expiry";

@Processor(PIPELINE_QUEUE)
export class PipelineProcessor extends WorkerHost {
  private readonly logger = new Logger("PipelineProcessor");

  constructor(
    private readonly pipeline: PipelineService,
    @Inject(STRATEGY_REGISTRY) private readonly registry: StrategyRegistry,
  ) {
    super();
  }

  override async process(
    job: Job<unknown, unknown, PipelineJobName>,
  ): Promise<void> {
    switch (job.name) {
      case "scan":
        return this.runForEach((id) => this.pipeline.runScan(id), "scan");
      case "monitor":
        return this.runForEach(
          (id) => this.pipeline.monitorPositions(id),
          "monitor",
        );
      case "expiry": {
        const expired = await this.pipeline.sweepExpiredProposals();
        if (expired > 0)
          this.logger.log(`expired ${expired} stale proposal(s)`);
        return;
      }
      default:
        this.logger.warn(`unknown pipeline job ${job.name}`);
    }
  }

  /** Run an action for every registered strategy runtime, isolating failures. */
  private async runForEach(
    action: (strategyId: string) => Promise<unknown>,
    label: string,
  ): Promise<void> {
    const runtimes = await this.registry.all();
    for (const rt of runtimes) {
      try {
        await action(rt.strategy.id);
      } catch (err) {
        this.logger.error(
          `${label} failed for ${rt.strategy.id}: ${(err as Error).message}`,
        );
      }
    }
  }
}

/** Registers the repeatable pipeline jobs on startup (idempotent). */
export class PipelineScheduler implements OnModuleInit {
  private readonly logger = new Logger("PipelineScheduler");

  constructor(
    @InjectQueue(PIPELINE_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    const jobs: Array<{ id: string; name: PipelineJobName; every: number }> = [
      {
        id: "pipeline-scan",
        name: "scan",
        every: this.config.PIPELINE_SCAN_INTERVAL_MS,
      },
      {
        id: "pipeline-monitor",
        name: "monitor",
        every: this.config.PIPELINE_MONITOR_INTERVAL_MS,
      },
      {
        id: "pipeline-expiry",
        name: "expiry",
        every: this.config.PIPELINE_EXPIRY_SWEEP_MS,
      },
    ];
    for (const job of jobs) {
      try {
        await this.queue.upsertJobScheduler(
          job.id,
          { every: job.every },
          { name: job.name },
        );
        this.logger.log(`scheduled ${job.name} every ${job.every}ms`);
      } catch (err) {
        this.logger.warn(
          `could not schedule ${job.name} (redis down?): ${(err as Error).message}`,
        );
      }
    }
  }
}
