/**
 * Seed the 8 strategies from spec §3.2. All start in WATCH mode / SIM target
 * (TASKS T0.3 AC), regardless of each strategy's eventual recommended mode —
 * every strategy is incubated in the simulator first and promoted through the
 * gates. Idempotent: existing rows are left untouched (never clobbers live
 * mode/target the user has changed). Roster lives in `seed-data.ts`.
 *
 * Usage: `DATABASE_URL=... pnpm --filter @magpie/db db:seed`
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { strategies } from "./schema.js";
import { ROSTER, buildSeedRows } from "./seed-data.js";

// Load the repo-root .env so `pnpm db:seed` works without exporting env by hand.
loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required to seed");
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  try {
    const inserted = await db
      .insert(strategies)
      .values(buildSeedRows())
      .onConflictDoNothing({ target: strategies.id })
      .returning({ id: strategies.id });

    console.log(
      `Seeded ${inserted.length} new strategies (of ${ROSTER.length}); existing left untouched.`,
    );
  } finally {
    await client.end();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  },
);
