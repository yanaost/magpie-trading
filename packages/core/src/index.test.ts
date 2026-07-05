import { describe, expect, it } from "vitest";
import { CORE_VERSION, bpsToFraction, roundCents } from "./index.js";

describe("core smoke", () => {
  it("exposes a version", () => {
    expect(CORE_VERSION).toBe("0.1.0");
  });

  it("converts basis points to a fraction", () => {
    expect(bpsToFraction(5)).toBeCloseTo(0.0005, 10);
    expect(bpsToFraction(0)).toBe(0);
    expect(bpsToFraction(10_000)).toBe(1);
  });

  it("rounds money to whole cents", () => {
    expect(roundCents(1.005)).toBe(1.01);
    expect(roundCents(2.675)).toBe(2.68);
    expect(roundCents(100)).toBe(100);
  });
});
