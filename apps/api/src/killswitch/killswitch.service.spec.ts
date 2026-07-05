/**
 * Integration test for the kill switch (T1.3 AC): trip the switch and assert a
 * pending proposal cannot execute, that order-capable strategies are demoted to
 * WATCH, and that the audit trail records the trip and each demotion. Uses
 * in-memory collaborators so it runs in CI without a live Postgres/Redis.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { EventsGateway } from "../ws/events.gateway.js";
import {
  KillSwitchActiveError,
  KillSwitchService,
} from "./killswitch.service.js";
import { REARM_CONFIRMATION } from "./killswitch.types.js";
import type {
  AuditEntry,
  AuditSink,
  DemotedStrategy,
  KillSwitchCache,
  KillSwitchRepository,
  KillSwitchState,
  StrategyRegistry,
} from "./killswitch.types.js";

class FakeRepo implements KillSwitchRepository {
  state: KillSwitchState = {
    active: false,
    reason: null,
    trippedBy: null,
    trippedAt: null,
    rearmedAt: null,
  };
  async read(): Promise<KillSwitchState> {
    return { ...this.state };
  }
  async trip(
    reason: string,
    trippedBy: string,
    at: Date,
  ): Promise<KillSwitchState> {
    this.state = {
      active: true,
      reason,
      trippedBy,
      trippedAt: at,
      rearmedAt: this.state.rearmedAt,
    };
    return { ...this.state };
  }
  async rearm(at: Date): Promise<KillSwitchState> {
    this.state = { ...this.state, active: false, rearmedAt: at };
    return { ...this.state };
  }
}

class FakeRegistry implements StrategyRegistry {
  constructor(public modes: Record<string, string>) {}
  async demoteAllToWatch(): Promise<DemotedStrategy[]> {
    const changed: DemotedStrategy[] = [];
    for (const [id, mode] of Object.entries(this.modes)) {
      if (mode === "AUTO" || mode === "APPROVE") {
        changed.push({ id, fromMode: mode });
        this.modes[id] = "WATCH";
      }
    }
    return changed;
  }
}

class FakeAudit implements AuditSink {
  entries: AuditEntry[] = [];
  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

class FakeCache implements KillSwitchCache {
  value: boolean | null = null;
  async get(): Promise<boolean | null> {
    return this.value;
  }
  async set(active: boolean): Promise<void> {
    this.value = active;
  }
}

/** Captures broadcast alerts without a real socket server. */
class FakeGateway {
  alerts: unknown[] = [];
  emitAlert(payload: unknown): void {
    this.alerts.push(payload);
  }
}

/** Stand-in for the order path: refuses to execute while the switch is active. */
async function executePendingProposal(svc: KillSwitchService): Promise<string> {
  await svc.assertOrdersAllowed();
  return "executed";
}

describe("KillSwitchService integration (T1.3)", () => {
  let repo: FakeRepo;
  let registry: FakeRegistry;
  let audit: FakeAudit;
  let cache: FakeCache;
  let gateway: FakeGateway;
  let svc: KillSwitchService;
  const AT = new Date("2026-07-05T15:30:00Z");

  beforeEach(() => {
    repo = new FakeRepo();
    registry = new FakeRegistry({
      "qual-sphb": "APPROVE",
      "momentum": "AUTO",
      "pairs": "WATCH",
      "snapback": "OFF",
    });
    audit = new FakeAudit();
    cache = new FakeCache();
    gateway = new FakeGateway();
    svc = new KillSwitchService(
      repo,
      registry,
      audit,
      cache,
      gateway as unknown as EventsGateway,
    );
  });

  it("allows execution before the switch is tripped", async () => {
    await expect(executePendingProposal(svc)).resolves.toBe("executed");
  });

  describe("after trip", () => {
    beforeEach(async () => {
      await svc.trip("daily loss limit breached", "system:daily_loss_limit", AT);
    });

    it("blocks a pending proposal from executing", async () => {
      await expect(executePendingProposal(svc)).rejects.toBeInstanceOf(
        KillSwitchActiveError,
      );
    });

    it("demotes AUTO/APPROVE strategies to WATCH, leaves WATCH/OFF alone", () => {
      expect(registry.modes).toEqual({
        "qual-sphb": "WATCH",
        "momentum": "WATCH",
        "pairs": "WATCH",
        "snapback": "OFF",
      });
    });

    it("writes audit rows for the trip and each demotion", () => {
      const trip = audit.entries.find((e) => e.action === "trip");
      expect(trip).toMatchObject({
        entityType: "kill_switch",
        entityId: "global",
        actor: "system:daily_loss_limit",
        after: { active: true },
      });
      const demotions = audit.entries.filter((e) => e.action === "demote");
      expect(demotions).toHaveLength(2);
      expect(demotions.map((d) => d.entityId).sort()).toEqual([
        "momentum",
        "qual-sphb",
      ]);
      for (const d of demotions) {
        expect(d.after).toEqual({ mode: "WATCH" });
        expect(["AUTO", "APPROVE"]).toContain(
          (d.before as { mode: string }).mode,
        );
      }
    });

    it("mirrors the active flag into the cache and broadcasts a critical alert", () => {
      expect(cache.value).toBe(true);
      expect(gateway.alerts).toContainEqual(
        expect.objectContaining({
          kind: "kill_switch",
          active: true,
          severity: "critical",
        }),
      );
    });

    it("persists reason and actor in state", async () => {
      const s = await svc.getState();
      expect(s.active).toBe(true);
      expect(s.reason).toBe("daily loss limit breached");
      expect(s.trippedBy).toBe("system:daily_loss_limit");
    });
  });

  describe("re-arm", () => {
    beforeEach(async () => {
      await svc.trip("manual", "user", AT);
    });

    it("rejects a wrong confirmation phrase and stays active", async () => {
      await expect(svc.rearm("rearm please", "user", AT)).rejects.toThrow(
        /confirmation phrase/,
      );
      expect((await svc.getState()).active).toBe(true);
    });

    it("re-arms with the exact confirmation and clears the block", async () => {
      const s = await svc.rearm(REARM_CONFIRMATION, "user", AT);
      expect(s.active).toBe(false);
      expect(cache.value).toBe(false);
      await expect(executePendingProposal(svc)).resolves.toBe("executed");
      expect(audit.entries.some((e) => e.action === "rearm")).toBe(true);
    });

    it("does NOT auto-restore demoted strategy modes on re-arm", async () => {
      await svc.rearm(REARM_CONFIRMATION, "user", AT);
      // qual-sphb was APPROVE, demoted to WATCH, and stays WATCH after re-arm
      expect(registry.modes["qual-sphb"]).toBe("WATCH");
    });
  });

  it("isActive fails safe to ACTIVE when both cache and DB are unavailable", async () => {
    const brokenCache: KillSwitchCache = {
      async get() {
        throw new Error("redis down");
      },
      async set() {
        throw new Error("redis down");
      },
    };
    const brokenRepo: KillSwitchRepository = {
      async read() {
        throw new Error("db down");
      },
      async trip() {
        throw new Error("db down");
      },
      async rearm() {
        throw new Error("db down");
      },
    };
    const s = new KillSwitchService(
      brokenRepo,
      registry,
      audit,
      brokenCache,
      gateway as unknown as EventsGateway,
    );
    expect(await s.isActive()).toBe(true);
  });
});
