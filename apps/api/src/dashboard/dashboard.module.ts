import { Module } from "@nestjs/common";
import { PipelineModule } from "../pipeline/pipeline.module.js";
import { DashboardController } from "./dashboard.controller.js";
import { DashboardService } from "./dashboard.service.js";

@Module({
  imports: [PipelineModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
