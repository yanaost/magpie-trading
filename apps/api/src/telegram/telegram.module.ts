/**
 * Telegram module (T1.8). Provides the Bot API wrapper and the outbound
 * proposal notifier. Deliberately a leaf (no pipeline dependency) so the
 * pipeline module can import it to compose notifiers without a cycle; the
 * inbound callback poller lives in the approvals module.
 */
import { Module } from "@nestjs/common";
import { TelegramApi } from "./telegram.api.js";
import { TelegramNotifier } from "./telegram.notifier.js";

@Module({
  providers: [TelegramApi, TelegramNotifier],
  exports: [TelegramApi, TelegramNotifier],
})
export class TelegramModule {}
