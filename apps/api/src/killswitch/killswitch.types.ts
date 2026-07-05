/**
 * Kill-switch contracts (spec §5, T1.3). The service depends on small,
 * plain-method collaborators (a repository, a strategy registry, an audit sink,
 * a cache) rather than the DB directly, so it can be integration-tested with
 * in-memory fakes while production wires Drizzle/Redis implementations.
 */
import type { Severity } from "@magpie/core";

/** The typed phrase a caller must send to re-arm (spec §5: typed confirmation). */
export const REARM_CONFIRMATION = "RE-ARM TRADING" as const;

/** DI token for the kill-switch persistence repository. */
export const KILL_SWITCH_REPOSITORY = Symbol("KILL_SWITCH_REPOSITORY");
/** DI token for the strategy registry (mode demotion). */
export const STRATEGY_REGISTRY = Symbol("STRATEGY_REGISTRY");
/** DI token for the append-only audit sink. */
export const AUDIT_SINK = Symbol("AUDIT_SINK");
/** DI token for the fast kill-switch cache (redis in prod). */
export const KILL_SWITCH_CACHE = Symbol("KILL_SWITCH_CACHE");

/** The persisted kill-switch state (mirrors the `kill_switch` singleton row). */
export interface KillSwitchState {
  active: boolean;
  reason: string | null;
  trippedBy: string | null;
  trippedAt: Date | null;
  rearmedAt: Date | null;
}

/** Persistence for the singleton kill-switch row. */
export interface KillSwitchRepository {
  /** Read the current state, creating the singleton row if absent. */
  read(): Promise<KillSwitchState>;
  /** Set active=true with the trip reason/actor at time `at`. */
  trip(reason: string, trippedBy: string, at: Date): Promise<KillSwitchState>;
  /** Set active=false at time `at` (never restores strategy modes). */
  rearm(at: Date): Promise<KillSwitchState>;
}

/** A strategy whose mode changed, for the audit trail. */
export interface DemotedStrategy {
  id: string;
  fromMode: string;
}

/** Strategy-mode operations the kill switch performs. */
export interface StrategyRegistry {
  /**
   * Demote every order-capable strategy (AUTO/APPROVE) to WATCH. Leaves WATCH
   * and OFF untouched (the kill switch stops trading; it never wakes strategies).
   * @returns the strategies that were changed (for auditing)
   */
  demoteAllToWatch(): Promise<DemotedStrategy[]>;
}

/** One append-only audit row (spec §7 `audit_log`). */
export interface AuditEntry {
  entityType: string;
  entityId: string;
  action: string;
  actor: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** Append-only audit sink. */
export interface AuditSink {
  append(entry: AuditEntry): Promise<void>;
}

/** Fast cross-process cache of the active flag. */
export interface KillSwitchCache {
  get(): Promise<boolean | null>;
  set(active: boolean): Promise<void>;
}

/** Notification payload broadcast on trip/re-arm. */
export interface KillSwitchAlert {
  kind: "kill_switch";
  active: boolean;
  reason: string | null;
  trippedBy: string | null;
  severity: Severity;
}
