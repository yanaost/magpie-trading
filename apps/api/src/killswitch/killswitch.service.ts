/**
 * KillSwitchService (spec §5, T1.3) — the global safety gate. Tripping it (by a
 * user or automatically by the RiskManager's daily-loss check) blocks all new
 * orders, demotes every order-capable strategy to `WATCH`, writes an
 * append-only audit trail, and notifies dashboards. Re-arming requires the typed
 * {@link REARM_CONFIRMATION} and deliberately does not restore strategy modes.
 *
 * The active flag lives in Postgres (source of truth) and is mirrored in Redis
 * for fast, cross-process order-path checks.
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { EventsGateway } from "../ws/events.gateway.js";
import {
  AUDIT_SINK,
  KILL_SWITCH_CACHE,
  KILL_SWITCH_REPOSITORY,
  REARM_CONFIRMATION,
  STRATEGY_REGISTRY,
  type AuditSink,
  type KillSwitchCache,
  type KillSwitchRepository,
  type KillSwitchState,
  type StrategyRegistry,
} from "./killswitch.types.js";

/** Thrown by {@link KillSwitchService.assertOrdersAllowed} when tripped. */
export class KillSwitchActiveError extends ForbiddenException {
  constructor(reason: string | null) {
    super(
      `Kill switch is active${reason ? `: ${reason}` : ""} — new orders are blocked.`,
    );
  }
}

@Injectable()
export class KillSwitchService {
  private readonly logger = new Logger("KillSwitchService");

  constructor(
    @Inject(KILL_SWITCH_REPOSITORY)
    private readonly repo: KillSwitchRepository,
    @Inject(STRATEGY_REGISTRY)
    private readonly strategies: StrategyRegistry,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(KILL_SWITCH_CACHE) private readonly cache: KillSwitchCache,
    private readonly events: EventsGateway,
  ) {}

  /** Current full state (source of truth: Postgres). Primes the cache. */
  async getState(): Promise<KillSwitchState> {
    const state = await this.repo.read();
    await this.cache.set(state.active).catch(() => undefined);
    return state;
  }

  /**
   * Fast "is trading blocked?" check. Reads Redis first (cheap, cross-process)
   * and falls back to Postgres on a cache miss. **Fails safe**: if both the
   * cache and the DB are unreachable, treats the switch as ACTIVE (blocked).
   */
  async isActive(): Promise<boolean> {
    try {
      const cached = await this.cache.get();
      if (cached !== null) return cached;
    } catch {
      // fall through to the DB
    }
    try {
      return (await this.getState()).active;
    } catch (err) {
      this.logger.error(
        `kill-switch state unavailable; failing safe to ACTIVE: ${String(err)}`,
      );
      return true;
    }
  }

  /**
   * Guard for the order path: throws {@link KillSwitchActiveError} when the
   * switch is active. Every executor calls this before placing an order.
   */
  async assertOrdersAllowed(): Promise<void> {
    if (await this.isActive()) {
      const reason = await this.getState()
        .then((s) => s.reason)
        .catch(() => null);
      throw new KillSwitchActiveError(reason);
    }
  }

  /**
   * Trip the switch. Idempotent side effects: demotes AUTO/APPROVE strategies to
   * WATCH, audits the trip and each demotion, updates the cache, and notifies.
   *
   * @param reason - human-readable reason (surfaced in the alert + audit)
   * @param trippedBy - "user" | "system:<rule>" | strategyId
   * @param now - logical timestamp (injectable for tests)
   */
  async trip(
    reason: string,
    trippedBy: string,
    now: Date = new Date(),
  ): Promise<KillSwitchState> {
    const before = await this.repo.read();
    const state = await this.repo.trip(reason, trippedBy, now);
    await this.cache.set(true).catch(() => undefined);

    const demoted = await this.strategies.demoteAllToWatch();

    await this.audit.append({
      entityType: "kill_switch",
      entityId: "global",
      action: "trip",
      actor: trippedBy,
      before: { active: before.active },
      after: { active: true, reason, trippedBy },
    });
    for (const s of demoted) {
      await this.audit.append({
        entityType: "strategy",
        entityId: s.id,
        action: "demote",
        actor: `system:kill_switch`,
        before: { mode: s.fromMode },
        after: { mode: "WATCH" },
      });
    }

    this.events.emitAlert({
      kind: "kill_switch",
      active: true,
      reason,
      trippedBy,
      severity: "critical",
    });
    this.logger.warn(
      `KILL SWITCH TRIPPED by ${trippedBy}: ${reason} (${demoted.length} strategies → WATCH)`,
    );
    return state;
  }

  /**
   * Re-arm the switch. Requires the exact typed confirmation; does NOT restore
   * strategy modes (the user re-enables strategies deliberately).
   *
   * @param confirmation - must equal {@link REARM_CONFIRMATION}
   * @param actor - who re-armed (usually "user")
   * @param now - logical timestamp (injectable for tests)
   */
  async rearm(
    confirmation: string,
    actor = "user",
    now: Date = new Date(),
  ): Promise<KillSwitchState> {
    if (confirmation !== REARM_CONFIRMATION) {
      throw new BadRequestException(
        `Re-arm requires the exact confirmation phrase "${REARM_CONFIRMATION}".`,
      );
    }
    const before = await this.repo.read();
    const state = await this.repo.rearm(now);
    await this.cache.set(false).catch(() => undefined);

    await this.audit.append({
      entityType: "kill_switch",
      entityId: "global",
      action: "rearm",
      actor,
      before: { active: before.active },
      after: { active: false },
    });
    this.events.emitAlert({
      kind: "kill_switch",
      active: false,
      reason: null,
      trippedBy: null,
      severity: "warning",
    });
    this.logger.warn(`Kill switch re-armed by ${actor}.`);
    return state;
  }
}
