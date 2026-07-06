/**
 * Worker liveness heartbeat (T3.6). Workers bump a single Redis key on each unit
 * of work; the uptime monitor reads its age to detect a stalled worker. Redis
 * (not in-process state) so it survives the worker and api being separate
 * processes/containers, and so "stalled" means "no work is being done anywhere",
 * not "this one object stopped ticking".
 *
 * Time is injected (`nowMs`) rather than read from the wall clock so the age
 * math is deterministic in tests.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { Redis } from "ioredis";
import { REDIS_CLIENT } from "../infra/infra.module.js";

export const WORKER_HEARTBEAT_KEY = "uptime:worker:heartbeat";

@Injectable()
export class WorkerHeartbeat {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Optional() private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /** Record that a worker just did work. Best-effort — never throws. */
  async beat(): Promise<void> {
    try {
      await this.redis.set(WORKER_HEARTBEAT_KEY, String(this.nowMs()));
    } catch {
      /* redis down → the monitor will report it via gateway/redis health */
    }
  }

  /**
   * Age of the last heartbeat in ms, or `null` if none has been recorded (or
   * Redis is unreadable). A negative age (clock skew) is clamped to 0.
   */
  async ageMs(): Promise<number | null> {
    try {
      const raw = await this.redis.get(WORKER_HEARTBEAT_KEY);
      if (raw === null) return null;
      const last = Number(raw);
      if (!Number.isFinite(last)) return null;
      return Math.max(0, this.nowMs() - last);
    } catch {
      return null;
    }
  }
}
