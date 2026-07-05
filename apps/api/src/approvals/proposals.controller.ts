/**
 * Approval REST surface (T1.8, spec §4.2/§9): list pending proposals and
 * approve/reject them. Approve accepts an optional **downward-only** size
 * override. All execution logic lives in {@link PipelineService.decideProposal};
 * this controller only maps outcomes to HTTP status codes.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import type { StoredProposal } from "../pipeline/pipeline.types.js";
import {
  PipelineService,
  ProposalDecisionError,
  type ProposalDecisionOutcome,
} from "../pipeline/pipeline.service.js";

const ApproveBodySchema = z.object({
  /** Optional downward-only size override; must be ≤ the proposed qty. */
  qty: z.number().positive().optional(),
});

/** JSON-friendly proposal shape for the dashboard. */
function toDto(p: StoredProposal) {
  return {
    id: p.id,
    strategyId: p.strategyId,
    ticker: p.ticker,
    side: p.side,
    qty: p.qty,
    entry: p.entry,
    stop: p.stop,
    target: p.target ?? null,
    riskUsd: p.riskUsd,
    riskPct: p.riskPct,
    status: p.status,
    executionTarget: p.executionTarget,
    expiry: p.expiry.toISOString(),
  };
}

@Controller("proposals")
export class ProposalsController {
  constructor(private readonly pipeline: PipelineService) {}

  /** Pending proposals awaiting a decision. */
  @Get()
  async list(): Promise<{ proposals: ReturnType<typeof toDto>[] }> {
    const pending = await this.pipeline.listPendingProposals();
    return { proposals: pending.map(toDto) };
  }

  /** Approve a proposal (optionally reducing size) → executes the SIM bracket. */
  @Post(":id/approve")
  async approve(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ProposalDecisionOutcome> {
    const { qty } = ApproveBodySchema.parse(body ?? {});
    return this.decide(id, "approve", qty === undefined ? {} : { qty });
  }

  /** Reject a proposal — no order is placed. */
  @Post(":id/reject")
  async reject(@Param("id") id: string): Promise<ProposalDecisionOutcome> {
    return this.decide(id, "reject", {});
  }

  private async decide(
    id: string,
    decision: "approve" | "reject",
    opts: { qty?: number },
  ): Promise<ProposalDecisionOutcome> {
    let outcome: ProposalDecisionOutcome;
    try {
      outcome = await this.pipeline.decideProposal(id, decision, opts);
    } catch (err) {
      if (err instanceof ProposalDecisionError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
    switch (outcome.kind) {
      case "not-found":
        throw new NotFoundException(`proposal ${id} not found`);
      case "not-pending":
        throw new ConflictException(
          `proposal ${id} is ${outcome.status}, not pending`,
        );
      default:
        return outcome;
    }
  }
}
