/**
 * Production implementations of the kill-switch collaborators: Postgres (via
 * Drizzle) for the singleton flag, the strategy demotion, and the audit trail;
 * Redis for the fast cross-process cache.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { schema, eq, inArray } from "@magpie/db";
import {
  DB_CLIENT,
  REDIS_CLIENT,
  type DbClient,
} from "../infra/infra.module.js";
import {
  type AuditEntry,
  type AuditSink,
  type DemotedStrategy,
  type KillSwitchCache,
  type KillSwitchRepository,
  type KillSwitchState,
  type StrategyRegistry,
} from "./killswitch.types.js";

const { killSwitch, KILL_SWITCH_ID, strategies, auditLog } = schema;

function toState(
  row: typeof killSwitch.$inferSelect | undefined,
): KillSwitchState {
  if (!row) {
    throw new Error("kill_switch singleton row missing after ensure/update");
  }
  return {
    active: row.active,
    reason: row.reason,
    trippedBy: row.trippedBy,
    trippedAt: row.trippedAt,
    rearmedAt: row.rearmedAt,
  };
}

/** Drizzle-backed persistence for the singleton `kill_switch` row. */
@Injectable()
export class DrizzleKillSwitchRepository implements KillSwitchRepository {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}

  async read(): Promise<KillSwitchState> {
    const { db } = this.dbClient;
    // Ensure the singleton exists (idempotent), then read it.
    await db
      .insert(killSwitch)
      .values({ id: KILL_SWITCH_ID, active: false })
      .onConflictDoNothing();
    const [row] = await db
      .select()
      .from(killSwitch)
      .where(eq(killSwitch.id, KILL_SWITCH_ID));
    return toState(row);
  }

  async trip(
    reason: string,
    trippedBy: string,
    at: Date,
  ): Promise<KillSwitchState> {
    await this.read(); // ensure the row exists
    const [row] = await this.dbClient.db
      .update(killSwitch)
      .set({ active: true, reason, trippedBy, trippedAt: at, updatedAt: at })
      .where(eq(killSwitch.id, KILL_SWITCH_ID))
      .returning();
    return toState(row);
  }

  async rearm(at: Date): Promise<KillSwitchState> {
    await this.read();
    const [row] = await this.dbClient.db
      .update(killSwitch)
      .set({ active: false, rearmedAt: at, updatedAt: at })
      .where(eq(killSwitch.id, KILL_SWITCH_ID))
      .returning();
    return toState(row);
  }
}

/** Drizzle-backed strategy demotion (AUTO/APPROVE → WATCH). */
@Injectable()
export class DrizzleStrategyRegistry implements StrategyRegistry {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}

  async demoteAllToWatch(): Promise<DemotedStrategy[]> {
    const { db } = this.dbClient;
    // Capture the real pre-change modes first (a single UPDATE can't return the
    // prior value), then demote in the same set.
    const targets = await db
      .select({ id: strategies.id, mode: strategies.mode })
      .from(strategies)
      .where(inArray(strategies.mode, ["AUTO", "APPROVE"]));
    if (targets.length === 0) return [];
    await db
      .update(strategies)
      .set({ mode: "WATCH", updatedAt: new Date() })
      .where(
        inArray(
          strategies.id,
          targets.map((t) => t.id),
        ),
      );
    return targets.map((t) => ({ id: t.id, fromMode: t.mode }));
  }
}

/** Drizzle-backed append-only audit sink. */
@Injectable()
export class DrizzleAuditSink implements AuditSink {
  constructor(@Inject(DB_CLIENT) private readonly dbClient: DbClient) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.dbClient.db.insert(auditLog).values({
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      actor: entry.actor,
      before: entry.before,
      after: entry.after,
    });
  }
}

/** Redis-backed cache of the active flag ("1"/"0"). */
@Injectable()
export class RedisKillSwitchCache implements KillSwitchCache {
  private readonly key = "killswitch:active";

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(): Promise<boolean | null> {
    const v = await this.redis.get(this.key);
    if (v === null) return null;
    return v === "1";
  }

  async set(active: boolean): Promise<void> {
    await this.redis.set(this.key, active ? "1" : "0");
  }
}
