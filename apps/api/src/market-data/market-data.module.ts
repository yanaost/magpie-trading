import { Module } from "@nestjs/common";
import { MarketDataService } from "./market-data.service.js";

/**
 * Market-data feature module. Owns the IB connection + realtime subscriptions
 * (when `MARKET_DATA_ENABLED`) and exposes {@link MarketDataService} for the
 * health/dashboard endpoints and the backfill flow.
 */
@Module({
  providers: [MarketDataService],
  exports: [MarketDataService],
})
export class MarketDataModule {}
