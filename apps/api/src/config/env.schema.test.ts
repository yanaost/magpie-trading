import { describe, expect, it } from "vitest";
import { loadConfig } from "./env.schema.js";

const VALID = {
  DATABASE_URL: "postgres://trader:trader@localhost:5432/trading",
  REDIS_URL: "redis://localhost:6379",
};

describe("env config validation", () => {
  it("parses a valid environment with defaults applied", () => {
    const cfg = loadConfig(VALID);
    expect(cfg.PORT).toBe(3001);
    expect(cfg.IB_GATEWAY_PORT).toBe(4002);
    expect(cfg.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
    expect(cfg.KILL_SWITCH_DAILY_LOSS_PCT).toBe(3);
    expect(cfg.DEMO_JOB_INTERVAL_MS).toBe(30_000);
  });

  it("coerces numeric env strings", () => {
    const cfg = loadConfig({ ...VALID, PORT: "4000", IB_GATEWAY_PORT: "4001" });
    expect(cfg.PORT).toBe(4000);
    expect(cfg.IB_GATEWAY_PORT).toBe(4001);
  });

  it("throws a readable error when DATABASE_URL is missing", () => {
    expect(() => loadConfig({ REDIS_URL: VALID.REDIS_URL })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("rejects a non-URL DATABASE_URL", () => {
    expect(() => loadConfig({ ...VALID, DATABASE_URL: "not-a-url" })).toThrow(
      /Invalid environment/,
    );
  });

  it("returns a frozen object", () => {
    const cfg = loadConfig(VALID);
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});
