/**
 * Approvals module (T1.8): the human decision surface over pending proposals —
 * REST (ProposalsController) and Telegram inline buttons (TelegramPoller). Both
 * route into the PipelineService, which owns execution; the WS `proposals`
 * channel (outbound) is wired in the pipeline module's composite notifier.
 */
import { Module } from "@nestjs/common";
import { PipelineModule } from "../pipeline/pipeline.module.js";
import { TelegramModule } from "../telegram/telegram.module.js";
import { ProposalsController } from "./proposals.controller.js";
import { TelegramPoller } from "./telegram-poller.js";

@Module({
  imports: [PipelineModule, TelegramModule],
  controllers: [ProposalsController],
  providers: [TelegramPoller],
})
export class ApprovalsModule {}
