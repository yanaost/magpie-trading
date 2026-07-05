/**
 * Wires the kill-switch service to its production collaborators (Drizzle for
 * persistence/audit/strategy demotion, Redis for the fast flag cache) and
 * exposes the service for other modules (the order path calls
 * `assertOrdersAllowed`) plus the HTTP controller.
 */
import { Module } from "@nestjs/common";
import { EventsModule } from "../ws/events.module.js";
import { KillSwitchController } from "./killswitch.controller.js";
import { KillSwitchService } from "./killswitch.service.js";
import {
  DrizzleAuditSink,
  DrizzleKillSwitchRepository,
  DrizzleStrategyRegistry,
  RedisKillSwitchCache,
} from "./killswitch.repository.js";
import {
  AUDIT_SINK,
  KILL_SWITCH_CACHE,
  KILL_SWITCH_REPOSITORY,
  STRATEGY_REGISTRY,
} from "./killswitch.types.js";

@Module({
  imports: [EventsModule],
  controllers: [KillSwitchController],
  providers: [
    KillSwitchService,
    { provide: KILL_SWITCH_REPOSITORY, useClass: DrizzleKillSwitchRepository },
    { provide: STRATEGY_REGISTRY, useClass: DrizzleStrategyRegistry },
    { provide: AUDIT_SINK, useClass: DrizzleAuditSink },
    { provide: KILL_SWITCH_CACHE, useClass: RedisKillSwitchCache },
  ],
  exports: [KillSwitchService],
})
export class KillSwitchModule {}
