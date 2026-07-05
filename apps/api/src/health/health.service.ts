import { Inject, Injectable } from "@nestjs/common";
import { Socket } from "node:net";
import { Redis } from "ioredis";
import { sql } from "@magpie/db";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";
import {
  DB_CLIENT,
  REDIS_CLIENT,
  type DbClient,
} from "../infra/infra.module.js";

export type DepStatus = "up" | "down";

export interface HealthReport {
  status: "ok" | "degraded";
  timestamp: string;
  deps: {
    db: DepStatus;
    redis: DepStatus;
    gateway: DepStatus;
  };
}

const PROBE_TIMEOUT_MS = 1500;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

/**
 * Probes each external dependency independently and reports per-dependency
 * status. Never throws — a down dependency yields `"down"`, not an error, so
 * `/healthz` always responds (spec §6 observability).
 */
@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthReport> {
    const [db, redis, gateway] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkGateway(),
    ]);
    const deps = { db, redis, gateway };
    const allUp = Object.values(deps).every((s) => s === "up");
    return {
      status: allUp ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      deps,
    };
  }

  private async checkDb(): Promise<DepStatus> {
    try {
      await withTimeout(
        this.dbClient.db.execute(sql`select 1`),
        PROBE_TIMEOUT_MS,
      );
      return "up";
    } catch {
      return "down";
    }
  }

  private async checkRedis(): Promise<DepStatus> {
    try {
      const pong = await withTimeout(this.redis.ping(), PROBE_TIMEOUT_MS);
      return pong === "PONG" ? "up" : "down";
    } catch {
      return "down";
    }
  }

  /** TCP-connect to the IB gateway host:port; open socket => reachable. */
  private checkGateway(): Promise<DepStatus> {
    return new Promise<DepStatus>((resolve) => {
      const socket = new Socket();
      const done = (status: DepStatus) => {
        socket.destroy();
        resolve(status);
      };
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once("connect", () => done("up"));
      socket.once("timeout", () => done("down"));
      socket.once("error", () => done("down"));
      socket.connect(this.config.IB_GATEWAY_PORT, this.config.IB_GATEWAY_HOST);
    });
  }
}
