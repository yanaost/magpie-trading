/**
 * Kill-switch HTTP surface (spec §9): read state, trip, and re-arm. The re-arm
 * (`DELETE`) requires a typed confirmation phrase in the body.
 */
import { Body, Controller, Delete, Get, Post } from "@nestjs/common";
import { z } from "zod";
import { KillSwitchService } from "./killswitch.service.js";
import type { KillSwitchState } from "./killswitch.types.js";

const TripBodySchema = z.object({
  reason: z.string().min(1).max(500).default("Manual trip"),
});
const RearmBodySchema = z.object({
  confirmation: z.string(),
});

@Controller("killswitch")
export class KillSwitchController {
  constructor(private readonly killSwitch: KillSwitchService) {}

  /** Current kill-switch state. */
  @Get()
  async getState(): Promise<KillSwitchState> {
    return this.killSwitch.getState();
  }

  /** Trip the kill switch manually (actor = user). */
  @Post()
  async trip(@Body() body: unknown): Promise<KillSwitchState> {
    const { reason } = TripBodySchema.parse(body ?? {});
    return this.killSwitch.trip(reason, "user");
  }

  /** Re-arm the kill switch; requires the typed confirmation phrase. */
  @Delete()
  async rearm(@Body() body: unknown): Promise<KillSwitchState> {
    const { confirmation } = RearmBodySchema.parse(body ?? {});
    return this.killSwitch.rearm(confirmation, "user");
  }
}
