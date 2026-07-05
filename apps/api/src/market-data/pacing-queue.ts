/**
 * A serialized, rate-limited request queue for IB API calls.
 *
 * IB enforces pacing on historical-data requests (≈60 requests per 10 minutes;
 * bursts trigger error 162 "pacing violation"). This queue:
 *  - runs tasks one at a time, spaced at least `minIntervalMs` apart, and
 *  - retries a task that fails with a pacing error using exponential backoff.
 *
 * The clock (`now`/`sleep`) is injectable so tests are deterministic without
 * real timers.
 */

export interface PacingError {
  code?: number;
  message?: string;
}

/** IB codes that indicate a pacing / historical-data-service throttle. */
const PACING_CODES = new Set([162, 420]);

export function isPacingError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as PacingError;
  if (typeof e.code === "number" && PACING_CODES.has(e.code)) return true;
  return typeof e.message === "string" && /pacing/i.test(e.message);
}

export interface PacingQueueOptions {
  /** Minimum spacing between the *start* of consecutive tasks. */
  minIntervalMs: number;
  /** Max retry attempts for a pacing-throttled task before giving up. */
  maxRetries: number;
  /** First backoff delay; doubles each retry up to `maxBackoffMs`. */
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Injectable clock (defaults to wall clock). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Optional hook for observability (retries, waits). */
  onEvent?: (event: PacingQueueEvent) => void;
}

export type PacingQueueEvent =
  | { type: "wait"; ms: number; label?: string }
  | { type: "retry"; attempt: number; backoffMs: number; label?: string }
  | { type: "giveup"; attempts: number; label?: string };

interface QueueItem<T> {
  task: () => Promise<T>;
  label?: string;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class PacingQueue {
  private readonly opts: Required<Omit<PacingQueueOptions, "onEvent">> & {
    onEvent?: (event: PacingQueueEvent) => void;
  };
  private readonly items: QueueItem<unknown>[] = [];
  private running = false;
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(options: PacingQueueOptions) {
    this.opts = {
      now: () => Date.now(),
      sleep: defaultSleep,
      ...options,
    };
  }

  /** Enqueue a task; resolves/rejects with the task's outcome. */
  enqueue<T>(task: () => Promise<T>, label?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.items.push({
        task: task as () => Promise<unknown>,
        label,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.drain();
    });
  }

  /** Number of tasks still waiting (excludes the one in flight). */
  get pending(): number {
    return this.items.length;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift();
        if (!item) break;
        await this.runItem(item);
      }
    } finally {
      this.running = false;
    }
  }

  private async runItem(item: QueueItem<unknown>): Promise<void> {
    await this.waitForSlot(item.label);

    let attempt = 0;
    for (;;) {
      this.lastStart = this.opts.now();
      try {
        const result = await item.task();
        item.resolve(result);
        return;
      } catch (err) {
        if (isPacingError(err) && attempt < this.opts.maxRetries) {
          const backoffMs = Math.min(
            this.opts.maxBackoffMs,
            this.opts.baseBackoffMs * 2 ** attempt,
          );
          attempt += 1;
          this.opts.onEvent?.({
            type: "retry",
            attempt,
            backoffMs,
            label: item.label,
          });
          await this.opts.sleep(backoffMs);
          continue;
        }
        if (isPacingError(err)) {
          this.opts.onEvent?.({
            type: "giveup",
            attempts: attempt + 1,
            label: item.label,
          });
        }
        item.reject(err);
        return;
      }
    }
  }

  /** Sleep until at least `minIntervalMs` has elapsed since the last start. */
  private async waitForSlot(label?: string): Promise<void> {
    const elapsed = this.opts.now() - this.lastStart;
    const waitMs = this.opts.minIntervalMs - elapsed;
    if (waitMs > 0 && Number.isFinite(waitMs)) {
      this.opts.onEvent?.({ type: "wait", ms: waitMs, label });
      await this.opts.sleep(waitMs);
    }
  }
}
