/**
 * Crowding-filter DI wiring (strategy #6, T2.4). Exposes the DB-backed filter,
 * the nightly refresh service, and the researcher — the live Anthropic
 * web-search researcher when an API key is configured, else the null researcher
 * so offline/CI runs never touch the network.
 */
import type { Provider } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import { DrizzleCrowdingFilter } from "./drizzle-crowding-filter.js";
import { CrowdingRefreshService } from "./crowding-refresh.service.js";
import { CROWDING_RESEARCHER } from "./crowding.types.js";
import {
  AnthropicCrowdingResearcher,
  NullCrowdingResearcher,
} from "./anthropic-crowding-researcher.js";

export const crowdingProviders: Provider[] = [
  DrizzleCrowdingFilter,
  CrowdingRefreshService,
  {
    provide: CROWDING_RESEARCHER,
    useFactory: (config: AppConfig) =>
      config.ANTHROPIC_API_KEY
        ? new AnthropicCrowdingResearcher(config)
        : new NullCrowdingResearcher(),
    inject: [APP_CONFIG],
  },
];
