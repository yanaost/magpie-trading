import { Module } from "@nestjs/common";
import { PipelineModule } from "../pipeline/pipeline.module.js";
import { DashboardModule } from "../dashboard/dashboard.module.js";
import { EventsModule } from "../ws/events.module.js";
import { DevController } from "./dev.controller.js";

/**
 * Dev-only trigger surface for the T1.9 demo. Pulls the PipelineService +
 * Simulator (order path), the DashboardService (positions snapshot), and the
 * EventsGateway (WS broadcast). The controller self-gates on DEV_TRIGGER_ENABLED.
 */
@Module({
  imports: [PipelineModule, DashboardModule, EventsModule],
  controllers: [DevController],
})
export class DevModule {}
