/**
 * ProposalsController unit tests (T1.8): verify the outcome→HTTP-status mapping
 * over a faked PipelineService (not-found → 404, not-pending → 409, invalid
 * size → 400, and the happy paths pass through).
 */
import { describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type {
  PipelineService,
  ProposalDecisionOutcome,
} from "../pipeline/pipeline.service.js";
import { ProposalDecisionError } from "../pipeline/pipeline.service.js";
import type { StoredProposal } from "../pipeline/pipeline.types.js";
import { ProposalsController } from "./proposals.controller.js";

function controllerWith(
  decide: (
    id: string,
    decision: "approve" | "reject",
    opts: { qty?: number },
  ) => Promise<ProposalDecisionOutcome>,
  pending: StoredProposal[] = [],
) {
  const pipeline = {
    decideProposal: vi.fn(decide),
    listPendingProposals: vi.fn(async () => pending),
  } as unknown as PipelineService;
  return { controller: new ProposalsController(pipeline), pipeline };
}

const STORED: StoredProposal = {
  id: "p-1",
  strategyId: "qual-sphb",
  ticker: "QUAL",
  side: "long",
  qty: 100,
  entry: 100,
  stop: 92,
  exitPlan: { stopLoss: 92, rules: [] },
  riskUsd: 800,
  riskPct: 0.8,
  status: "pending",
  executionTarget: "SIM",
  expiry: new Date("2026-07-05T15:00:00.000Z"),
};

describe("ProposalsController", () => {
  it("lists pending proposals as JSON DTOs", async () => {
    const { controller } = controllerWith(
      async () => ({ kind: "not-found", id: "x" }),
      [STORED],
    );
    const res = await controller.list();
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]).toMatchObject({
      id: "p-1",
      ticker: "QUAL",
      expiry: expect.any(String),
    });
  });

  it("approve passes an optional qty and returns the executed outcome", async () => {
    const { controller, pipeline } = controllerWith(async () => ({
      kind: "executed",
      id: "p-1",
      ticker: "QUAL",
      qty: 50,
      bracketId: "br-1",
    }));
    const out = await controller.approve("p-1", { qty: 50 });
    expect(pipeline.decideProposal).toHaveBeenCalledWith("p-1", "approve", {
      qty: 50,
    });
    expect(out).toMatchObject({ kind: "executed", bracketId: "br-1" });
  });

  it("approve without a body sends no qty override", async () => {
    const { controller, pipeline } = controllerWith(async () => ({
      kind: "executed",
      id: "p-1",
      ticker: "QUAL",
      qty: 100,
      bracketId: "br-1",
    }));
    await controller.approve("p-1", undefined);
    expect(pipeline.decideProposal).toHaveBeenCalledWith("p-1", "approve", {});
  });

  it("maps not-found → 404 and not-pending → 409", async () => {
    const nf = controllerWith(async () => ({ kind: "not-found", id: "p-1" }));
    await expect(nf.controller.reject("p-1")).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const np = controllerWith(async () => ({
      kind: "not-pending",
      id: "p-1",
      status: "executed",
    }));
    await expect(np.controller.reject("p-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("maps a ProposalDecisionError → 400", async () => {
    const { controller } = controllerWith(async () => {
      throw new ProposalDecisionError("size can only be reduced");
    });
    await expect(
      controller.approve("p-1", { qty: 999 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a non-positive qty at the schema boundary", async () => {
    const { controller } = controllerWith(async () => ({
      kind: "not-found",
      id: "p-1",
    }));
    await expect(controller.approve("p-1", { qty: -5 })).rejects.toBeTruthy();
  });
});
