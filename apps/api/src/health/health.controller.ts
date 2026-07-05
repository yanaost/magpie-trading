import { Controller, Get } from "@nestjs/common";
import { HealthService, type HealthReport } from "./health.service.js";

/** `/healthz` — per-dependency health (db, redis, gateway). Always 200. */
@Controller("healthz")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async check(): Promise<HealthReport> {
    return this.health.check();
  }
}
