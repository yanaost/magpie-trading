/**
 * @magpie/db — Drizzle schema, client, and migration/seed entrypoints.
 */
export * as schema from "./schema.js";
export { createDb, type Database } from "./client.js";
// Re-export the drizzle SQL tag so consumers can build raw fragments (e.g.
// health probes) without depending on drizzle-orm directly.
export { sql } from "drizzle-orm";
