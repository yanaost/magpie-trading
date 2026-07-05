/**
 * Database client factory. Wraps postgres.js + drizzle-orm.
 *
 * Callers pass the connection string explicitly (from validated config) so this
 * package has no hidden env dependency and is easy to test.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>["db"];

/**
 * Create a drizzle client and its underlying postgres.js connection.
 *
 * @param connectionString - e.g. `process.env.DATABASE_URL`
 * @param options.max - pool size (default 10; use 1 for migration/CLI scripts)
 * @returns `{ db, sql }` — the drizzle instance and the raw client (call
 *   `sql.end()` to close).
 */
export function createDb(
  connectionString: string,
  options: { max?: number } = {},
) {
  const sql = postgres(connectionString, { max: options.max ?? 10 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
