import { describe, expect, it, vi } from "vitest";
import {
  isPacingError,
  PacingQueue,
  type PacingQueueEvent,
} from "./pacing-queue.js";

/** A deterministic virtual clock: `sleep` advances `now` synchronously. */
function virtualClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("isPacingError", () => {
  it("recognizes IB pacing codes and messages", () => {
    expect(isPacingError({ code: 162 })).toBe(true);
    expect(isPacingError({ code: 420 })).toBe(true);
    expect(
      isPacingError({ message: "Historical data request pacing violation" }),
    ).toBe(true);
    expect(isPacingError({ code: 200 })).toBe(false);
    expect(isPacingError(new Error("no security definition"))).toBe(false);
    expect(isPacingError(null)).toBe(false);
    expect(isPacingError("nope")).toBe(false);
  });
});

describe("PacingQueue", () => {
  it("spaces consecutive tasks by at least minIntervalMs", async () => {
    const clock = virtualClock();
    const queue = new PacingQueue({
      minIntervalMs: 10_000,
      maxRetries: 3,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    const order: number[] = [];
    const results = await Promise.all([
      queue.enqueue(async () => {
        order.push(1);
        return 1;
      }),
      queue.enqueue(async () => {
        order.push(2);
        return 2;
      }),
      queue.enqueue(async () => {
        order.push(3);
        return 3;
      }),
    ]);

    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]); // FIFO
    // First runs immediately; the next two each wait one full interval.
    expect(clock.sleeps).toEqual([10_000, 10_000]);
  });

  it("retries a pacing error with exponential backoff, then succeeds", async () => {
    const clock = virtualClock();
    const events: PacingQueueEvent[] = [];
    const queue = new PacingQueue({
      minIntervalMs: 0,
      maxRetries: 5,
      baseBackoffMs: 2_000,
      maxBackoffMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      onEvent: (e) => events.push(e),
    });

    const task = vi
      .fn()
      .mockRejectedValueOnce({ code: 162, message: "pacing violation" })
      .mockRejectedValueOnce({ code: 162, message: "pacing violation" })
      .mockResolvedValueOnce("ok");

    const result = await queue.enqueue(task, "QUAL:1d");
    expect(result).toBe("ok");
    expect(task).toHaveBeenCalledTimes(3);
    // Backoffs: 2000, then 4000.
    const retries = events.filter((e) => e.type === "retry");
    expect(retries.map((e) => (e as { backoffMs: number }).backoffMs)).toEqual([
      2_000, 4_000,
    ]);
  });

  it("gives up after maxRetries pacing errors and rejects", async () => {
    const clock = virtualClock();
    const events: PacingQueueEvent[] = [];
    const queue = new PacingQueue({
      minIntervalMs: 0,
      maxRetries: 2,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
      onEvent: (e) => events.push(e),
    });

    const task = vi.fn().mockRejectedValue({ code: 162 });
    await expect(queue.enqueue(task, "SPY:5m")).rejects.toMatchObject({
      code: 162,
    });
    // initial try + 2 retries = 3 attempts
    expect(task).toHaveBeenCalledTimes(3);
    expect(events.some((e) => e.type === "giveup")).toBe(true);
  });

  it("does not retry a non-pacing error", async () => {
    const queue = new PacingQueue({
      minIntervalMs: 0,
      maxRetries: 5,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
    });
    const task = vi.fn().mockRejectedValue(new Error("no security definition"));
    await expect(queue.enqueue(task)).rejects.toThrow("no security definition");
    expect(task).toHaveBeenCalledTimes(1);
  });
});
