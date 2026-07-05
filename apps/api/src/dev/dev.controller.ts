import {
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { Simulator } from "@magpie/core";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import {
  PipelineService,
  type SignalOutcome,
} from "../pipeline/pipeline.service.js";
import { SIMULATOR } from "../pipeline/pipeline.providers.js";
import { EventsGateway } from "../ws/events.gateway.js";
import { DashboardService } from "../dashboard/dashboard.service.js";

/** Optional overrides for the synthetic trigger. */
interface TriggerBody {
  ticker?: string;
  entry?: number;
}

/**
 * Dev-only endpoints for the T1.9 full-loop demo. Gated by `DEV_TRIGGER_ENABLED`
 * (defaults on outside production); a production boot without the flag returns
 * 403. `POST /dev/trigger/:strategyId` seeds a SIM quote and injects a
 * synthetic long-QUAL signal through the *real* risk + mode gate, so approving
 * it in APPROVE mode fills a live SIM position the dashboard then streams.
 */
@Controller("dev")
export class DevController {
  private readonly enabled: boolean;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly pipeline: PipelineService,
    @Inject(SIMULATOR) private readonly simulator: Simulator,
    private readonly gateway: EventsGateway,
    private readonly dashboard: DashboardService,
  ) {
    this.enabled =
      config.DEV_TRIGGER_ENABLED ?? config.NODE_ENV !== "production";
  }

  @Post("trigger/:strategyId")
  async trigger(
    @Param("strategyId") strategyId: string,
    @Body() body: TriggerBody = {},
  ): Promise<{ outcome: SignalOutcome }> {
    if (!this.enabled) {
      throw new ForbiddenException("dev trigger disabled");
    }

    const ticker = body.ticker ?? "QUAL";
    const entry = body.entry ?? 100;

    // Seed the Simulator's own quote so an approved market bracket fills at the
    // demo price (the SIM fill uses this quote, independent of DB candles).
    this.simulator.updateQuote({
      ticker,
      bid: entry,
      ask: entry,
      last: entry,
      ts: new Date(),
    });

    const outcome = await this.pipeline.injectSyntheticProposal(strategyId, {
      ticker,
      entry,
    });

    // Push a fresh positions snapshot (AUTO mode fills immediately; APPROVE
    // waits for the button, but re-broadcasting is harmless and keeps the
    // dashboard current).
    this.gateway.emitPositions(await this.dashboard.openPositions());

    return { outcome };
  }
}
