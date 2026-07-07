/**
 * REST surface for the LLM dialog log (U1): a paginated, filterable list of
 * persisted analyses and a by-id detail with the full dialog. Read-only — it
 * maps query params to a {@link LlmLogService} call and 404s an unknown id.
 * Mirrors the Nest style of proposals.controller.ts (Zod-validated input).
 */
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import {
  LlmLogService,
  type LlmLogDetail,
  type LlmLogPage,
} from "./llm-log.service.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Query params for the list endpoint; every filter is optional. */
const ListQuerySchema = z.object({
  signalId: z.string().min(1).optional(),
  strategyId: z.string().min(1).optional(),
  ticker: z.string().min(1).optional(),
  purpose: z.enum(["signal_analysis", "crowding_scan"]).optional(),
  verdict: z.enum(["proceed", "veto"]).optional(),
  outcome: z.enum(["proceed", "veto", "veto_by_failure"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().nonnegative().default(0),
});

@Controller("llm-logs")
export class LlmLogController {
  constructor(private readonly service: LlmLogService) {}

  /** Paginated, filterable list of dialog rows (newest-first). */
  @Get()
  async list(@Query() query: unknown): Promise<LlmLogPage> {
    const parsed = ListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? "bad query",
      );
    }
    return this.service.list(parsed.data);
  }

  /** Full captured dialog for one row. */
  @Get(":id")
  async detail(@Param("id") id: string): Promise<LlmLogDetail> {
    const row = await this.service.detail(id);
    if (!row) throw new NotFoundException(`llm log ${id} not found`);
    return row;
  }
}
