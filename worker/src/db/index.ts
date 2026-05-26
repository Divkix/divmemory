import type { Database as BunDatabase } from "bun:sqlite";
import { BunSQLiteAdapter } from "./bun-sqlite-adapter";
import { D1DrizzleAdapter } from "./d1-adapter";
import type { Database } from "./types";

export type {
	AtomicStatement,
	CollectFn,
	Database,
	DrizzleSchemaDb,
	MemoryRow,
	ProjectRow,
	SessionRow,
	WriteResult,
} from "./types";
export { normalizeWriteResult } from "./types";
export { BunSQLiteAdapter, createBunSqliteClient } from "./bun-sqlite-adapter";
export { createD1Client, D1DrizzleAdapter } from "./d1-adapter";
export { createInMemoryDatabase, InMemoryAdapter } from "./memory-adapter";
export { dbClient, resolveDatabase } from "./helpers";

export function isDatabase(value: unknown): value is Database {
	return (
		typeof value === "object" &&
		value !== null &&
		"client" in value &&
		"atomic" in value &&
		typeof (value as Database).atomic === "function"
	);
}

/** Construct the appropriate adapter from a D1 binding or bun:sqlite handle. */
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

/** Production D1 adapter from a Worker binding. */
export function createDatabaseFromEnv(db: D1Database): Database {
	return new D1DrizzleAdapter(db).asDatabase();
}
