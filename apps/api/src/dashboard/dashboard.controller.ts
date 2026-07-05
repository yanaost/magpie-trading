import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
} from "@nestjs/common";
import {
  DashboardService,
  type CandleCount,
  type JournalView,
  type PortfolioSummary,
  type PositionView,
  type StrategySummary,
} from "./dashboard.service.js";

const MODES = ["AUTO", "APPROVE", "WATCH", "OFF"] as const;
const TARGETS = ["SIM", "PAPER", "LIVE"] as const;

/** PATCH body for a strategy mode/target change (validated below). */
interface StrategyPatch {
  mode?: string;
  target?: string;
}

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

  /** Change a strategy's mode and/or execution target (T1.9 control surface). */
  @Patch("strategies/:id")
  async setStrategy(
    @Param("id") id: string,
    @Body() body: StrategyPatch,
  ): Promise<StrategySummary> {
    if (body.mode !== undefined && !MODES.includes(body.mode as never)) {
      throw new BadRequestException(`invalid mode: ${body.mode}`);
    }
    if (body.target !== undefined && !TARGETS.includes(body.target as never)) {
      throw new BadRequestException(`invalid target: ${body.target}`);
    }
    if (body.mode === undefined && body.target === undefined) {
      throw new BadRequestException("nothing to update (mode or target)");
    }
    const updated = await this.dashboard.setStrategy(id, {
      mode: body.mode,
      target: body.target,
    });
    if (!updated) throw new NotFoundException(`unknown strategy: ${id}`);
    return updated;
  }

  @Get("positions")
  positions(@Query("strategyId") strategyId?: string): Promise<PositionView[]> {
    return this.dashboard.openPositions(strategyId);
  }

  @Get("portfolio")
  portfolio(): Promise<PortfolioSummary> {
    return this.dashboard.portfolio();
  }

  @Get("signals")
  signals(@Query("strategyId") strategyId?: string): Promise<JournalView[]> {
    return this.dashboard.signalLog(strategyId);
  }

  @Get("journal")
  journal(@Query("strategyId") strategyId?: string): Promise<JournalView[]> {
    return this.dashboard.journal(strategyId);
  }
}
