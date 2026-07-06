/**
 * Nightly crowding-refresh scheduling (BRINGUP B1 / T2.4).
 *
 * The crowding refresh is wired as a fourth repeatable pipeline job. These
 * tests pin two guarantees:
 *  - the scheduler registers `pipeline-crowding` on the configured cadence
 *    alongside scan/monitor/expiry;
 *  - the processor's `crowding` tick runs the refresh, and *isolates* its
 *    failures (no key / no credits / provider down) so a bad nightly run logs
 *    and leaves the last good crowded_tickers set in place instead of crashing
 *    the worker.
 */
import { describe, expect, it, vi } from "vitest";
import type { Job, Queue } from "bullmq";
import { PipelineProcessor, PipelineScheduler } from "./pipeline.processor.js";
import type { CrowdingRefreshService } from "../crowding/crowding-refresh.service.js";
import type { PipelineService } from "./pipeline.service.js";
import type { StrategyRegistry } from "./pipeline.types.js";
import type { AppConfig } from "../config/env.schema.js";

const crowdingJob = { name: "crowding" } as unknown as Job<
  unknown,
  unknown,
  "crowding"
>;

function makeProcessor(refresh: CrowdingRefreshService["refresh"]) {
  const pipeline = {} as PipelineService;
  const registry = {
    all: vi.fn().mockResolvedValue([]),
  } as unknown as StrategyRegistry;
  const crowding = { refresh } as unknown as CrowdingRefreshService;
  return new PipelineProcessor(pipeline, registry, crowding);
}

describe("PipelineProcessor — crowding job", () => {
  it("runs the crowding refresh on a crowding tick", async () => {
    const refresh = vi.fn().mockResolvedValue({
      tickers: ["NVDA", "SMCI"],
      expiresAt: "2026-08-01",
    });
    const processor = makeProcessor(refresh);

    await processor.process(crowdingJob);

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("isolates refresh failures — a bad run never throws (fail inert)", async () => {
    const refresh = vi
      .fn()
      .mockRejectedValue(new Error("credit balance is too low"));
    const processor = makeProcessor(refresh);

    await expect(processor.process(crowdingJob)).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("PipelineScheduler — crowding job registration", () => {
  it("registers pipeline-crowding on the configured cadence", async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    const queue = { upsertJobScheduler } as unknown as Queue;
    const config = {
      PIPELINE_SCAN_INTERVAL_MS: 60_000,
      PIPELINE_MONITOR_INTERVAL_MS: 30_000,
      PIPELINE_EXPIRY_SWEEP_MS: 60_000,
      PIPELINE_CROWDING_REFRESH_MS: 86_400_000,
    } as AppConfig;

    await new PipelineScheduler(queue, config).onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      "pipeline-crowding",
      { every: 86_400_000 },
      { name: "crowding" },
    );
  });

  it("tolerates Redis being down at boot (logs, does not throw)", async () => {
    const upsertJobScheduler = vi
      .fn()
      .mockRejectedValue(new Error("redis down"));
    const queue = { upsertJobScheduler } as unknown as Queue;
    const config = {
      PIPELINE_SCAN_INTERVAL_MS: 60_000,
      PIPELINE_MONITOR_INTERVAL_MS: 30_000,
      PIPELINE_EXPIRY_SWEEP_MS: 60_000,
      PIPELINE_CROWDING_REFRESH_MS: 86_400_000,
    } as AppConfig;

    await expect(
      new PipelineScheduler(queue, config).onModuleInit(),
    ).resolves.toBeUndefined();
  });
});
