/**
 * Telegram notifier (T1.8): renders a pending proposal as a chat message with
 * inline Approve / Reject buttons. Implements the pipeline's {@link ProposalNotifier}
 * port so it composes alongside the WS notifier. Outbound only — no dependency
 * on the pipeline, so it sits in a leaf module (the inbound callback poller
 * lives in the approvals module, which owns the PipelineService).
 */
import { Injectable } from "@nestjs/common";
import type { TradeProposal } from "@magpie/core";
import type { ProposalNotifier } from "../pipeline/pipeline.types.js";
import { TelegramApi } from "./telegram.api.js";

/** Build the callback_data payloads the poller parses back. */
export const approveCallback = (id: string): string => `approve:${id}`;
export const rejectCallback = (id: string): string => `reject:${id}`;

/** Render a proposal into the notification text (kept pure for tests). */
export function renderProposal(p: TradeProposal & { id: string }): string {
  const target = p.target != null ? `\nTarget: ${p.target}` : "";
  return (
    `<b>Proposal ${p.strategyId}</b>\n` +
    `${p.side.toUpperCase()} ${p.qty} ${p.ticker} @ ${p.entry}\n` +
    `Stop: ${p.stop}${target}\n` +
    `Risk: $${p.riskUsd.toFixed(2)} (${p.riskPct.toFixed(2)}%)\n` +
    `Expires: ${p.expiry.toISOString()}`
  );
}

@Injectable()
export class TelegramNotifier implements ProposalNotifier {
  constructor(private readonly api: TelegramApi) {}

  async proposalPending(
    proposal: TradeProposal & { id: string },
  ): Promise<void> {
    if (!this.api.enabled || !this.api.chatId) return;
    await this.api.sendWithButtons(this.api.chatId, renderProposal(proposal), [
      [
        { text: "✅ Approve", callback_data: approveCallback(proposal.id) },
        { text: "❌ Reject", callback_data: rejectCallback(proposal.id) },
      ],
    ]);
  }
}
