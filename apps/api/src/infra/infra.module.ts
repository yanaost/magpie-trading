import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
} from "@nestjs/common";
import { Redis } from "ioredis";
import { createDb, type Database } from "@magpie/db";
import { APP_CONFIG, type AppConfig } from "../config/env.schema.js";

/** DI token for the drizzle {@link Database} + its raw postgres client. */
export const DB_CLIENT = Symbol("DB_CLIENT");
/** DI token for the shared ioredis client (cache, pub/sub, health). */
export const REDIS_CLIENT = Symbol("REDIS_CLIENT");

export interface DbClient {
  db: Database;
  sql: ReturnType<typeof createDb>["sql"];
}

/** Closes the DB pool and redis client on shutdown. */
@Injectable()
class InfraLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(DB_CLIENT) private readonly dbClient: DbClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.dbClient.sql.end({ timeout: 5 }).catch(() => undefined);
    this.redis.disconnect();
  }
}

/**
 * Global infrastructure module: one Postgres pool and one Redis client, shared
 * across the app and closed cleanly on shutdown.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): DbClient =>
        createDb(config.DATABASE_URL, { max: 10 }),
    },
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis => {
        const client = new Redis(config.REDIS_URL, {
          maxRetriesPerRequest: null,
          retryStrategy: (times) => Math.min(times * 200, 2000),
        });
        // Swallow connection errors here; the health check reports status.
        client.on("error", () => undefined);
        return client;
      },
    },
    InfraLifecycle,
  ],
  exports: [DB_CLIENT, REDIS_CLIENT],
})
export class InfraModule {}
