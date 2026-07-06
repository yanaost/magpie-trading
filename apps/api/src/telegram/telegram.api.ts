/**
 * Thin wrapper over the Telegram Bot HTTP API (T1.8). Isolated behind an
 * injectable so the notifier/poller are unit-testable without the network, and
 * so the whole feature no-ops safely when `TELEGRAM_BOT_TOKEN` is unset (dev,
 * CI, and the default SIM environment all boot without a bot).
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";

/** One inline keyboard button (a subset of Telegram's shape). */
export interface InlineButton {
  text: string;
  callback_data: string;
}

/** A Telegram `Update` (only the fields we consume). */
export interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
}

@Injectable()
export class TelegramApi {
  private readonly logger = new Logger(TelegramApi.name);
  private readonly token?: string;
  readonly chatId?: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.token = config.TELEGRAM_BOT_TOKEN;
    this.chatId = config.TELEGRAM_CHAT_ID;
  }

  /** Whether the bot is configured (token present). */
  get enabled(): boolean {
    return Boolean(this.token);
  }

  /**
   * Call a Bot API method. Returns the parsed `result` on success, or `null`
   * when unconfigured or on any transport/HTTP error (logged, never thrown —
   * the trading path must not fail because Telegram is down).
   */
  async call<T = unknown>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.token) return null;
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const json = (await res.json()) as {
        ok: boolean;
        result?: T;
        description?: string;
      };
      if (!json.ok) {
        this.logger.warn(
          `Telegram ${method} failed: ${json.description ?? "unknown"}`,
        );
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      this.logger.warn(`Telegram ${method} error: ${(err as Error).message}`);
      return null;
    }
  }

  /** Send a plain HTML message (no buttons) — used for auto-trade alerts. */
  async sendText(chatId: string, text: string): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    });
  }

  /** Send a message with an inline keyboard (one button row per array entry). */
  async sendWithButtons(
    chatId: string,
    text: string,
    rows: InlineButton[][],
  ): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  }

  /** Acknowledge a callback query (removes the client's loading spinner). */
  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  /** Replace a message's text (used to reflect the decision inline). */
  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
    });
  }

  /** Long-poll for updates since `offset`. Returns [] when unconfigured/error. */
  async getUpdates(offset: number, timeoutSec = 25): Promise<TelegramUpdate[]> {
    const result = await this.call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout: timeoutSec,
      allowed_updates: ["callback_query"],
    });
    return result ?? [];
  }
}
