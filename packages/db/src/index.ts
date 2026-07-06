/**
 * @magpie/db — Drizzle schema, client, and migration/seed entrypoints.
 */
export * as schema from "./schema.js";
export { createDb, type Database } from "./client.js";
// Re-export the drizzle SQL tag and common query helpers so consumers can build
// queries without depending on drizzle-orm directly.
export {
  sql,
  eq,
  ne,
  and,
  or,
  inArray,
  desc,
  asc,
  gt,
  gte,
  lt,
  lte,
} from "drizzle-orm";
