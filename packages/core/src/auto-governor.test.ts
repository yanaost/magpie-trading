import { describe, it, expect } from "vitest";
import { AutoGovernor } from "./auto-governor.js";

const SID = "squeeze-scalp";
const T = (iso: string) => new Date(iso);

describe("AutoGovernor — daily trade cap", () => {
  it("admits up to the cap, then blocks further entries the same day", () => {
    const g = new AutoGovernor({ maxTradesPerDay: 3 });
    const now = T("2024-06-03T14:00:00.000Z");
    for (let i = 0; i < 3; i += 1) {
      expect(g.admitEntry(SID, now).allowed).toBe(true);
      g.recordEntry(SID, now);
    }
    const blocked = g.admitEntry(SID, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked).toHaveProperty("reason");
  });

  it("rolls the counter over at the UTC day boundary", () => {
    const g = new AutoGovernor({ maxTradesPerDay: 1 });
    const day1 = T("2024-06-03T20:00:00.000Z");
    g.recordEntry(SID, day1);
    expect(g.admitEntry(SID, day1).allowed).toBe(false);
    // Next UTC day → the cap resets.
    const day2 = T("2024-06-04T13:31:00.000Z");
    expect(g.admitEntry(SID, day2).allowed).toBe(true);
  });

  it("keeps caps independent per strategy", () => {
    const g = new AutoGovernor({ maxTradesPerDay: 1 });
    const now = T("2024-06-03T14:00:00.000Z");
    g.recordEntry("a", now);
    expect(g.admitEntry("a", now).allowed).toBe(false);
    expect(g.admitEntry("b", now).allowed).toBe(true);
  });
});

describe("AutoGovernor — consecutive-loss cooldown", () => {
  const now = T("2024-06-03T14:00:00.000Z");

  it("demotes exactly once after N consecutive losses", () => {
    const g = new AutoGovernor({ maxConsecutiveLosses: 3 });
    expect(g.recordResult(SID, -10, now).demote).toBe(false);
    expect(g.recordResult(SID, -5, now).demote).toBe(false);
    const trip = g.recordResult(SID, -1, now);
    expect(trip.demote).toBe(true);
    expect(trip.consecutiveLosses).toBe(3);
    expect(trip.demoted).toBe(true);
    // A further loss keeps it demoted but does not re-fire the transition.
    expect(g.recordResult(SID, -1, now).demote).toBe(false);
  });

  it("resets the streak on a win", () => {
    const g = new AutoGovernor({ maxConsecutiveLosses: 3 });
    g.recordResult(SID, -10, now);
    g.recordResult(SID, -10, now);
    expect(g.recordResult(SID, 20, now).consecutiveLosses).toBe(0);
    // Streak restarts from zero, so it takes three more to demote.
    g.recordResult(SID, -10, now);
    g.recordResult(SID, -10, now);
    expect(g.recordResult(SID, -10, now).demote).toBe(true);
  });

  it("treats a scratch (zero P&L) as a non-loss that resets the streak", () => {
    const g = new AutoGovernor({ maxConsecutiveLosses: 2 });
    g.recordResult(SID, -10, now);
    expect(g.recordResult(SID, 0, now).consecutiveLosses).toBe(0);
  });

  it("blocks auto entries once demoted", () => {
    const g = new AutoGovernor({
      maxConsecutiveLosses: 1,
      maxTradesPerDay: 99,
    });
    g.recordResult(SID, -10, now);
    expect(g.isDemoted(SID, now)).toBe(true);
    expect(g.admitEntry(SID, now).allowed).toBe(false);
  });

  it("clears the cooldown on re-promotion", () => {
    const g = new AutoGovernor({ maxConsecutiveLosses: 1 });
    g.recordResult(SID, -10, now);
    expect(g.admitEntry(SID, now).allowed).toBe(false);
    g.clearCooldown(SID, now);
    expect(g.isDemoted(SID, now)).toBe(false);
    expect(g.admitEntry(SID, now).allowed).toBe(true);
  });
});
