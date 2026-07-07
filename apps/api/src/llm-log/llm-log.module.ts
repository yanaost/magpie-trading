/**
 * Wires the read-only LLM dialog-log surface (U1). Only needs the global
 * DB_CLIENT (provided by InfraModule), so it declares no imports.
 */
import { Module } from "@nestjs/common";
import { LlmLogController } from "./llm-log.controller.js";
import { LlmLogService } from "./llm-log.service.js";

@Module({
  controllers: [LlmLogController],
  providers: [LlmLogService],
  exports: [LlmLogService],
})
export class LlmLogModule {}
