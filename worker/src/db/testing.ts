/**
 * Test-only database adapters (bun:sqlite). Do not import from Worker entrypoints —
 * Wrangler cannot bundle `bun:sqlite` for Cloudflare deploys.
 */
import type { Database as BunDatabase } from "bun:sqlite";
import { BunSQLiteAdapter } from "./bun-sqlite-adapter";
import { D1DrizzleAdapter } from "./d1-adapter";
import type { Database } from "./types";

export { BunSQLiteAdapter, createBunSqliteClient } from "./bun-sqlite-adapter";
export { createInMemoryDatabase, InMemoryAdapter } from "./memory-adapter";

/** Construct the appropriate adapter from a D1 binding or bun:sqlite handle (tests). */
export function createDatabase(source: D1Database | BunDatabase): Database {
	if (
		source &&
		typeof source === "object" &&
		"batch" in source &&
		typeof (source as D1Database).batch === "function"
	) {
		return new D1DrizzleAdapter(source as D1Database).asDatabase();
	}
	return new BunSQLiteAdapter(source as BunDatabase).asDatabase();
}
