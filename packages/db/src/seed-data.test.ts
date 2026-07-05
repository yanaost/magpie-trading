import { describe, expect, it } from "vitest";
import { strategies } from "./schema.js";
import { ROSTER, buildSeedRows } from "./seed-data.js";

describe("strategy seed roster", () => {
  it("has all 8 strategies from spec §3.2", () => {
    expect(ROSTER).toHaveLength(8);
  });

  it("has unique ids", () => {
    const ids = ROSTER.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only valid timeframe enum values", () => {
    const valid = new Set(strategies.timeframe.enumValues);
    for (const s of ROSTER) {
      expect(valid.has(s.timeframe)).toBe(true);
    }
  });

  it("includes the expected roster ids", () => {
    expect(ROSTER.map((s) => s.id).sort()).toEqual(
      [
        "ai-crowding-filter",
        "earnings-fade",
        "friday-monday-flow",
        "hype-momentum",
        "qual-sphb",
        "snapback",
        "squeeze-scalp",
        "valuation-gravity",
      ].sort(),
    );
  });

  it("seeds every strategy as WATCH mode / SIM target", () => {
    const rows = buildSeedRows();
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.mode).toBe("WATCH");
      expect(r.target).toBe("SIM");
    }
  });
});
