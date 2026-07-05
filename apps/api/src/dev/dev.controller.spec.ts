/**
 * DevController unit tests (T1.9). Verifies the enable/disable gate and that a
 * trigger seeds a SIM quote, injects through the pipeline, and broadcasts a
 * positions snapshot. All collaborators are faked — no DB, no network.
 */
import { describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import type { Simulator } from "@magpie/core";
import type { AppConfig } from "../config/env.schema.js";
import type { PipelineService } from "../pipeline/pipeline.service.js";
import type { EventsGateway } from "../ws/events.gateway.js";
import type { DashboardService } from "../dashboard/dashboard.service.js";
import { DevController } from "./dev.controller.js";

function make(config: Partial<AppConfig>) {
  const inject = vi.fn(async () => ({
    kind: "proposed" as const,
    ticker: "QUAL",
    proposalId: "p-1",
  }));
  const updateQuote = vi.fn();
  const emitPositions = vi.fn();
  const openPositions = vi.fn(async () => []);
  const controller = new DevController(
    config as AppConfig,
    { injectSyntheticProposal: inject } as unknown as PipelineService,
    { updateQuote } as unknown as Simulator,
    { emitPositions } as unknown as EventsGateway,
    { openPositions } as unknown as DashboardService,
  );
  return { controller, inject, updateQuote, emitPositions, openPositions };
}

describe("DevController gate", () => {
  it("is enabled by default outside production", async () => {
    const { controller, inject } = make({ NODE_ENV: "development" });
    const res = await controller.trigger("qual-sphb", { entry: 100 });
    expect(res.outcome).toMatchObject({ kind: "proposed" });
    expect(inject).toHaveBeenCalledWith("qual-sphb", {
      ticker: "QUAL",
      entry: 100,
    });
  });

  it("is disabled in production unless explicitly enabled", async () => {
    const { controller, inject } = make({ NODE_ENV: "production" });
    await expect(controller.trigger("qual-sphb")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(inject).not.toHaveBeenCalled();
  });

  it("honours an explicit DEV_TRIGGER_ENABLED=false override", async () => {
    const { controller } = make({
      NODE_ENV: "development",
      DEV_TRIGGER_ENABLED: false,
    });
    await expect(controller.trigger("qual-sphb")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("honours an explicit DEV_TRIGGER_ENABLED=true in production", async () => {
    const { controller, inject } = make({
      NODE_ENV: "production",
      DEV_TRIGGER_ENABLED: true,
    });
    await controller.trigger("qual-sphb");
    expect(inject).toHaveBeenCalled();
  });
});

describe("DevController.trigger", () => {
  it("seeds a SIM quote, injects, and broadcasts positions", async () => {
    const { controller, updateQuote, emitPositions, openPositions } = make({
      NODE_ENV: "development",
    });
    await controller.trigger("qual-sphb", { entry: 120 });

    expect(updateQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        ticker: "QUAL",
        last: 120,
        bid: 120,
        ask: 120,
      }),
    );
    expect(openPositions).toHaveBeenCalledOnce();
    expect(emitPositions).toHaveBeenCalledOnce();
  });
});
