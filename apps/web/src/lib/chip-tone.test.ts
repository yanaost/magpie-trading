import { describe, expect, it } from "vitest";
import { modeTone, targetTone, type ChipTone } from "./chip-tone";

describe("chip colour mapping (spec §U3)", () => {
  it("maps every mode to its seriousness tone", () => {
    const expected: Record<string, ChipTone> = {
      OFF: "idle",
      WATCH: "idle",
      APPROVE: "amber",
      AUTO: "danger",
    };
    for (const [mode, tone] of Object.entries(expected)) {
      expect(modeTone(mode)).toBe(tone);
    }
  });

  it("maps every target to its seriousness tone", () => {
    const expected: Record<string, ChipTone> = {
      SIM: "idle",
      PAPER: "amber",
      LIVE: "danger",
    };
    for (const [target, tone] of Object.entries(expected)) {
      expect(targetTone(target)).toBe(tone);
    }
  });

  it("is case-insensitive and falls back to idle for unknown values", () => {
    expect(modeTone("auto")).toBe("danger");
    expect(targetTone("live")).toBe("danger");
    expect(modeTone("bogus")).toBe("idle");
    expect(targetTone("mars")).toBe("idle");
  });
});
