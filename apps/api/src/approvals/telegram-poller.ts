/**
 * Telegram inbound poller (T1.8): long-polls `getUpdates` for the inline
 * Approve/Reject button presses and routes them into
 * {@link PipelineService.decideProposal}. Lives in the approvals module (which
 * owns the PipelineService) so the Telegram module stays a leaf.
 *
 * No-ops entirely when the bot is unconfigured, so dev/CI/SIM boot without it.
 */
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PipelineService } from "../pipeline/pipeline.service.js";
import { TelegramApi, type TelegramUpdate } from "../telegram/telegram.api.js";

/** Parse a `callback_data` string into a decision, or null if unrecognized. */
export function parseCallback(
  data: string | undefined,
): { decision: "approve" | "reject"; id: string } | null {
  if (!data) return null;
  const [verb, id] = data.split(":");
  if ((verb === "approve" || verb === "reject") && id) {
    return { decision: verb, id };
  }
  return null;
}

@Injectable()
export class TelegramPoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramPoller.name);
  private offset = 0;
  private running = false;

  constructor(
    private readonly api: TelegramApi,
    private readonly pipeline: PipelineService,
  ) {}

  onModuleInit(): void {
    if (!this.api.enabled) {
      this.logger.log("Telegram not configured — approval polling disabled");
      return;
    }
    this.running = true;
    void this.loop();
  }

  onModuleDestroy(): void {
    this.running = false;
  }

  /** The long-poll loop. Each error backs off implicitly via the poll timeout. */
  private async loop(): Promise<void> {
    while (this.running) {
      const updates = await this.api.getUpdates(this.offset);
      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        await this.dispatch(update);
      }
    }
  }

  /**
   * Handle one update: decide the proposal, acknowledge the button, and edit
   * the message to reflect the outcome. Returns the human summary (also used
   * by tests). Never throws — a bad update must not kill the loop.
   */
  async dispatch(update: TelegramUpdate): Promise<string | null> {
    const cb = update.callback_query;
    const parsed = parseCallback(cb?.data);
    if (!cb || !parsed) return null;

    let summary: string;
    try {
      const outcome = await this.pipeline.decideProposal(
        parsed.id,
        parsed.decision,
        {},
      );
      switch (outcome.kind) {
        case "executed":
          summary = `✅ Approved & executed ${outcome.qty} ${outcome.ticker}`;
          break;
        case "rejected":
          summary = `❌ Rejected ${outcome.ticker}`;
          break;
        case "not-found":
          summary = `⚠️ Proposal not found`;
          break;
        case "not-pending":
          summary = `⚠️ Already ${outcome.status}`;
          break;
      }
    } catch (err) {
      summary = `⚠️ ${(err as Error).message}`;
      this.logger.warn(`decision failed: ${(err as Error).message}`);
    }

    await this.api.answerCallback(cb.id, summary);
    if (cb.message) {
      await this.api.editMessageText(
        cb.message.chat.id,
        cb.message.message_id,
        summary,
      );
    }
    return summary;
  }
}
