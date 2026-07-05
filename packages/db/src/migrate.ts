/**
 * Migration runner. Applies all Drizzle SQL migrations in `./migrations`,
 * then runs idempotent post-migration steps (the TimescaleDB hypertable
 * conversion, which degrades to a plain table when the extension is absent).
 *
 * Usage: `DATABASE_URL=... pnpm --filter @magpie/db db:migrate`
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../migrations");

/**
 * Convert `candles` into a TimescaleDB hypertable partitioned on `ts`.
 * Guarded: if the `timescaledb` extension is unavailable (e.g. plain Postgres
 * in local dev) it logs a notice and leaves `candles` as a normal table, so
 * `db:migrate` still succeeds everywhere. On the Timescale image it produces a
 * real hypertable. Idempotent via `if_not_exists`.
 */
const HYPERTABLE_SQL = sql`
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    PERFORM create_hypertable(
      'candles', 'ts',
      if_not_exists => TRUE,
      migrate_data => TRUE
    );
    RAISE NOTICE 'candles is a TimescaleDB hypertable';
  ELSE
    RAISE NOTICE 'timescaledb extension unavailable — candles remains a plain table (dev fallback)';
  END IF;
END
$$;
`;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  try {
    console.log(`Applying migrations from ${MIGRATIONS_DIR} ...`);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    console.log("Schema migrations applied.");

    console.log("Ensuring candles hypertable ...");
    await db.execute(HYPERTABLE_SQL);
    console.log("Post-migration steps complete.");
  } finally {
    await client.end();
  }
}

main().then(
  () => {
    console.log("✅ Migration complete.");
    process.exit(0);
  },
  (err: unknown) => {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  },
);
