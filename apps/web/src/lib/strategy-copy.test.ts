import { describe, expect, it } from "vitest";
import {
  MODE_DESCRIPTIONS,
  TARGET_DESCRIPTIONS,
  formatTtl,
  modeCaption,
  targetCaption,
  needsAutoConfirmation,
} from "./strategy-copy";

describe("strategy mode/target copy (spec §U4)", () => {
  it("keeps the spec copy verbatim for every mode and target", () => {
    // Guards against accidental paraphrasing — the AC forbids jargon drift.
    expect(MODE_DESCRIPTIONS.AUTO).toBe(
      "Trades by itself when a signal passes all checks. You're notified after.",
    );
    expect(MODE_DESCRIPTIONS.APPROVE).toBe(
      "Builds the full trade and asks you first. Unanswered proposals expire.",
    );
    expect(MODE_DESCRIPTIONS.WATCH).toBe(
      "Finds and journals signals but never trades. For observing and incubating.",
    );
    expect(MODE_DESCRIPTIONS.OFF).toBe(
      "Loaded but idle. No scanning, no signals.",
    );
    expect(TARGET_DESCRIPTIONS.SIM).toBe(
      "Practice mode — Magpie's built-in simulator, virtual money, instant resets.",
    );
    expect(TARGET_DESCRIPTIONS.PAPER).toBe(
      "Real orders to Interactive Brokers' practice account. Fake money, real plumbing.",
    );
    expect(TARGET_DESCRIPTIONS.LIVE).toBe(
      "Real money. Locked until a strategy earns promotion.",
    );
  });

  it("renders every mode/target caption non-empty", () => {
    for (const mode of Object.keys(MODE_DESCRIPTIONS)) {
      expect(modeCaption(mode, 900_000).length).toBeGreaterThan(0);
    }
    for (const target of Object.keys(TARGET_DESCRIPTIONS)) {
      expect(targetCaption(target).length).toBeGreaterThan(0);
    }
  });

  it("shows the real configured TTL in the APPROVE caption", () => {
    expect(modeCaption("APPROVE", 900_000)).toContain("15 min");
    // Rendered from config: a different TTL changes the text.
    expect(modeCaption("APPROVE", 300_000)).toContain("5 min");
    expect(modeCaption("APPROVE", 300_000)).not.toContain("15 min");
    // Non-APPROVE captions don't carry a TTL line.
    expect(modeCaption("WATCH", 900_000)).not.toContain("expire after");
  });

  it("formats TTL as whole minutes or seconds", () => {
    expect(formatTtl(900_000)).toBe("15 min");
    expect(formatTtl(60_000)).toBe("1 min");
    expect(formatTtl(90_000)).toBe("90 sec");
  });

  it("requires confirmation only when switching to AUTO", () => {
    expect(needsAutoConfirmation("AUTO")).toBe(true);
    expect(needsAutoConfirmation("auto")).toBe(true);
    expect(needsAutoConfirmation("APPROVE")).toBe(false);
    expect(needsAutoConfirmation("WATCH")).toBe(false);
    expect(needsAutoConfirmation("OFF")).toBe(false);
  });
});
