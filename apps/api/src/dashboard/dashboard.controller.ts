import { Controller, Get } from "@nestjs/common";
import {
  DashboardService,
  type CandleCount,
  type StrategySummary,
} from "./dashboard.service.js";

/** REST endpoints consumed by the dashboard (apps/web). */
@Controller("api")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("strategies")
  strategies(): Promise<StrategySummary[]> {
    return this.dashboard.strategies();
  }

  @Get("candles/counts")
  candleCounts(): Promise<CandleCount[]> {
    return this.dashboard.candleCounts();
  }
}
