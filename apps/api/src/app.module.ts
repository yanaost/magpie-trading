import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { ConfigModule } from "./config/config.module.js";
import { InfraModule } from "./infra/infra.module.js";
import { HealthModule } from "./health/health.module.js";
import { QueueModule } from "./queue/queue.module.js";
import { EventsModule } from "./ws/events.module.js";
import { MarketDataModule } from "./market-data/market-data.module.js";
import { DashboardModule } from "./dashboard/dashboard.module.js";
import { KillSwitchModule } from "./killswitch/killswitch.module.js";
import { LlmModule } from "./llm/llm.module.js";
import { LlmLogModule } from "./llm-log/llm-log.module.js";
import { PipelineModule } from "./pipeline/pipeline.module.js";
import { ApprovalsModule } from "./approvals/approvals.module.js";
import { BacktestModule } from "./backtest/backtest.module.js";
import { UptimeModule } from "./uptime/uptime.module.js";
import { DevModule } from "./dev/dev.module.js";

/**
 * Root module. Order matters: config is global and loaded first; infra
 * (db/redis) and the pino logger depend on it; feature modules follow.
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === "production" ? "info" : "debug",
        transport:
          process.env.NODE_ENV === "production"
            ? undefined
            : { target: "pino-pretty", options: { singleLine: true } },
        autoLogging: false,
      },
    }),
    InfraModule,
    HealthModule,
    QueueModule,
    EventsModule,
    MarketDataModule,
    DashboardModule,
    KillSwitchModule,
    LlmModule,
    LlmLogModule,
    PipelineModule,
    ApprovalsModule,
    BacktestModule,
    UptimeModule,
    DevModule,
  ],
})
export class AppModule {}
