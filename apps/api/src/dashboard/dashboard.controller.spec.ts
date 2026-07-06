/**
 * DashboardController unit tests (T2.2 AC: "e2e — attempt early promotion
 * rejected with reason"). Verify the PATCH validation and the promotion-gate
 * error → HTTP-status mapping over a faked DashboardService.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { DashboardController } from "./dashboard.controller.js";
import type { DashboardService, StrategySummary } from "./dashboard.service.js";
import { PromotionGateError } from "../promotion/promotion-gate.js";

function controllerWith(setStrategy: DashboardService["setStrategy"]) {
  const dashboard = {
    setStrategy: vi.fn(setStrategy),
  } as unknown as DashboardService;
  return { controller: new DashboardController(dashboard), dashboard };
}

const SUMMARY: StrategySummary = {
  id: "qual-sphb",
  name: "QUAL/SPHB",
  timeframe: "swing",
  mode: "APPROVE",
  target: "PAPER",
};

describe("DashboardController.setStrategy", () => {
  it("rejects an invalid mode / target / empty body with 400", async () => {
    const { controller } = controllerWith(async () => SUMMARY);
    await expect(
      controller.setStrategy("qual-sphb", { mode: "BOGUS" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.setStrategy("qual-sphb", { target: "MARS" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.setStrategy("qual-sphb", {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("maps an unknown strategy to 404", async () => {
    const { controller } = controllerWith(async () => null);
    await expect(
      controller.setStrategy("nope", { mode: "APPROVE" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("maps a blocked promotion to 422 with the gate's code + reason", async () => {
    const { controller } = controllerWith(async () => {
      throw new PromotionGateError(
        "INSUFFICIENT_TRADES",
        "Promotion SIM → PAPER needs ≥30 closed trades at SIM; only 3 so far.",
      );
    });
    try {
      await controller.setStrategy("qual-sphb", {
        target: "PAPER",
        note: "go",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      const body = (err as UnprocessableEntityException).getResponse();
      expect(body).toMatchObject({
        code: "INSUFFICIENT_TRADES",
        message: expect.stringContaining("30 closed trades"),
      });
    }
  });

  it("passes the review note through on a promotion", async () => {
    const { controller, dashboard } = controllerWith(async () => SUMMARY);
    const result = await controller.setStrategy("qual-sphb", {
      target: "PAPER",
      note: "ready",
    });
    expect(result).toBe(SUMMARY);
    expect(dashboard.setStrategy).toHaveBeenCalledWith("qual-sphb", {
      mode: undefined,
      target: "PAPER",
      note: "ready",
    });
  });
});
