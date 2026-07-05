import { Module } from "@nestjs/common";
import { HealthModule } from "../health/health.module.js";
import { EventsGateway } from "./events.gateway.js";
import { StatusBroadcaster } from "./status.broadcaster.js";

@Module({
  imports: [HealthModule],
  providers: [EventsGateway, StatusBroadcaster],
  exports: [EventsGateway],
})
export class EventsModule {}
