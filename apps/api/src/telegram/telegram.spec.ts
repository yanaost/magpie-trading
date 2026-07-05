/**
 * Telegram notifier + poller unit tests (T1.8). The Bot API is faked — no
 * network — so we verify the message/keyboard shape, the callback parsing, and
 * that inbound button presses route into the pipeline decision.
 */
import { describe, expect, it, vi } from "vitest";
import type { TradeProposal } from "@magpie/core";
import type { PipelineService } from "../pipeline/pipeline.service.js";
import type { TelegramApi, TelegramUpdate } from "./telegram.api.js";
import {
  TelegramNotifier,
  renderProposal,
  approveCallback,
  rejectCallback,
} from "./telegram.notifier.js";
import { TelegramPoller, parseCallback } from "../approvals/telegram-poller.js";

const PROPOSAL: TradeProposal & { id: string } = {
  id: "p-1",
  signalId: "00000000-0000-0000-0000-000000000000",
  strategyId: "qual-sphb",
  ticker: "QUAL",
  side: "long",
  qty: 100,
  entry: 100,
  stop: 92,
  exitPlan: { stopLoss: 92, rules: [] },
  riskUsd: 800,
  riskPct: 0.8,
  status: "pending",
  executionTarget: "SIM",
  expiry: new Date("2026-07-05T15:00:00.000Z"),
};

/** A recording fake over the subset of TelegramApi the units call. */
function fakeApi(overrides: Partial<TelegramApi> = {}) {
  return {
    enabled: true,
    chatId: "42",
    sendWithButtons: vi.fn(async () => {}),
    answerCallback: vi.fn(async () => {}),
    editMessageText: vi.fn(async () => {}),
    getUpdates: vi.fn(async () => [] as TelegramUpdate[]),
    ...overrides,
  } as unknown as TelegramApi & {
    sendWithButtons: ReturnType<typeof vi.fn>;
    answerCallback: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
  };
}

describe("renderProposal / callbacks", () => {
  it("renders side, qty, ticker, stop, and risk", () => {
    const text = renderProposal(PROPOSAL);
    expect(text).toContain("LONG 100 QUAL @ 100");
    expect(text).toContain("Stop: 92");
    expect(text).toContain("qual-sphb");
  });

  it("encodes and decodes callback payloads", () => {
    expect(approveCallback("p-1")).toBe("approve:p-1");
    expect(rejectCallback("p-1")).toBe("reject:p-1");
    expect(parseCallback("approve:p-1")).toEqual({
      decision: "approve",
      id: "p-1",
    });
    expect(parseCallback("reject:p-1")).toEqual({
      decision: "reject",
      id: "p-1",
    });
    expect(parseCallback("garbage")).toBeNull();
    expect(parseCallback(undefined)).toBeNull();
  });
});

describe("TelegramNotifier", () => {
  it("sends an Approve/Reject keyboard when enabled", async () => {
    const api = fakeApi();
    await new TelegramNotifier(api).proposalPending(PROPOSAL);
    expect(api.sendWithButtons).toHaveBeenCalledOnce();
    const [chatId, , rows] = api.sendWithButtons.mock.calls[0]!;
    expect(chatId).toBe("42");
    expect(rows[0]).toEqual([
      { text: "✅ Approve", callback_data: "approve:p-1" },
      { text: "❌ Reject", callback_data: "reject:p-1" },
    ]);
  });

  it("no-ops when the bot is not configured", async () => {
    const api = fakeApi({ enabled: false });
    await new TelegramNotifier(api).proposalPending(PROPOSAL);
    expect(
      (api as { sendWithButtons: ReturnType<typeof vi.fn> }).sendWithButtons,
    ).not.toHaveBeenCalled();
  });
});

describe("TelegramPoller.dispatch", () => {
  function pollerWith(
    decide: PipelineService["decideProposal"],
    api = fakeApi(),
  ) {
    const pipeline = { decideProposal: decide } as unknown as PipelineService;
    return { poller: new TelegramPoller(api, pipeline), api };
  }
  const update = (data: string): TelegramUpdate => ({
    update_id: 1,
    callback_query: {
      id: "cb1",
      data,
      message: { chat: { id: 42 }, message_id: 7 },
    },
  });

  it("routes an approve press into decideProposal and confirms inline", async () => {
    const decide = vi.fn(async () => ({
      kind: "executed" as const,
      id: "p-1",
      ticker: "QUAL",
      qty: 100,
      bracketId: "br-1",
    }));
    const { poller, api } = pollerWith(decide);

    const summary = await poller.dispatch(update("approve:p-1"));

    expect(decide).toHaveBeenCalledWith("p-1", "approve", {});
    expect(summary).toContain("Approved");
    expect(api.answerCallback).toHaveBeenCalledWith("cb1", summary);
    expect(api.editMessageText).toHaveBeenCalledWith(42, 7, summary);
  });

  it("routes a reject press", async () => {
    const decide = vi.fn(async () => ({
      kind: "rejected" as const,
      id: "p-1",
      ticker: "QUAL",
    }));
    const { poller } = pollerWith(decide);
    const summary = await poller.dispatch(update("reject:p-1"));
    expect(decide).toHaveBeenCalledWith("p-1", "reject", {});
    expect(summary).toContain("Rejected");
  });

  it("ignores updates without a valid callback", async () => {
    const decide = vi.fn();
    const { poller } = pollerWith(
      decide as unknown as PipelineService["decideProposal"],
    );
    expect(await poller.dispatch({ update_id: 2 })).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it("surfaces a decision error as a warning summary, without throwing", async () => {
    const decide = vi.fn(async () => {
      throw new Error("boom");
    });
    const { poller } = pollerWith(
      decide as unknown as PipelineService["decideProposal"],
    );
    const summary = await poller.dispatch(update("approve:p-1"));
    expect(summary).toContain("boom");
  });
});
