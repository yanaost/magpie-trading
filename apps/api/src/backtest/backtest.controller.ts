import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
} from "@nestjs/common";
import type { PremarketGapper } from "@magpie/strategies";
import { BacktestService, type BacktestWindow } from "./backtest.service.js";
import type { StoredBacktestRun } from "./backtest-report.store.js";

/** POST body to trigger a snapback wait-time comparison over a window. */
interface RunComparisonBody {
  from?: string;
  to?: string;
  timeframe?: string;
  waits?: number[];
  gappers?: PremarketGapper[];
}

/** REST surface for variant backtest reports (T3.5), consumed by apps/web. */
@Controller("api")
export class BacktestController {
  constructor(private readonly backtest: BacktestService) {}

  /** The persisted variant-comparison rows for a strategy (newest first). */
  @Get("strategies/:id/backtests")
  list(@Param("id") id: string): Promise<StoredBacktestRun[]> {
    return this.backtest.list(id);
  }

  /**
   * Run the snapback 30 vs 60-min wait comparison over `[from, to]` and persist
   * both reports (§4.4 AC). Gappers must be supplied — the historical pre-market
   * universe is not in the candle store.
   */
  @Post("strategies/:id/backtests")
  async run(
    @Param("id") id: string,
    @Body() body: RunComparisonBody,
  ): Promise<StoredBacktestRun[]> {
    const from = parseDate(body.from, "from");
    const to = parseDate(body.to, "to");
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException("`from` must be before `to`");
    }
    const window: BacktestWindow = {
      from,
      to,
      timeframe: (body.timeframe as BacktestWindow["timeframe"]) ?? "5m",
    };
    await this.backtest.compareSnapbackWaits(
      id,
      window,
      body.gappers ?? [],
      body.waits ?? [30, 60],
    );
    return this.backtest.list(id);
  }
}

function parseDate(value: string | undefined, field: string): Date {
  if (!value) throw new BadRequestException(`\`${field}\` is required`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`\`${field}\` is not a valid date: ${value}`);
  }
  return d;
}
