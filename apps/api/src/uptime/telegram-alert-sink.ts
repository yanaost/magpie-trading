/**
 * Telegram alert sink (T3.6) — delivers uptime {@link AlertEvent}s to the
 * operator's chat. Reuses the shared {@link TelegramApi} (outbound only), so it
 * no-ops safely when the bot is unconfigured (dev/CI/SIM), exactly like the
 * proposal notifier.
 */
import { Injectable } from "@nestjs/common";
import { TelegramApi } from "../telegram/telegram.api.js";
import {
  renderAlert,
  type AlertEvent,
  type AlertSink,
} from "./uptime.types.js";

@Injectable()
export class TelegramAlertSink implements AlertSink {
  constructor(private readonly api: TelegramApi) {}

  async deliver(event: AlertEvent): Promise<void> {
    if (!this.api.enabled || !this.api.chatId) return;
    await this.api.sendText(this.api.chatId, renderAlert(event));
  }
}
