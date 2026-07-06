/**
 * Backtest module (T3.5) — variant comparison reports (§4.4). Owns the report
 * store, the service that runs variants through the replay money path, and the
 * REST surface the variant-comparison tab reads. Depends only on {@link
 * InfraModule} (the DB client); the replay collaborators are constructed
 * per-run inside the service so each variant stays isolated.
 */
import { Module } from "@nestjs/common";
import { InfraModule } from "../infra/infra.module.js";
import { BacktestController } from "./backtest.controller.js";
import { BacktestReportStore } from "./backtest-report.store.js";
import { BacktestService } from "./backtest.service.js";

@Module({
  imports: [InfraModule],
  controllers: [BacktestController],
  providers: [BacktestReportStore, BacktestService],
  exports: [BacktestService],
})
export class BacktestModule {}
