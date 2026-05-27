import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type * as schema from "../schema";

/**
 * Typed Drizzle client surface (bun-sqlite shape).
 * D1 production clients are cast to this type; query APIs are compatible at runtime.
 */
export type DrizzleSchemaDb = BunSQLiteDatabase<typeof schema>;

export type MemoryRow = typeof schema.memories.$inferSelect;
export type SessionRow = typeof schema.sessions.$inferSelect;
export type ProjectRow = typeof schema.projects.$inferSelect;

export type AtomicStatement = { run: () => unknown | Promise<unknown> };

export type CollectFn = (stmt: AtomicStatement) => void;

export type WriteResult = { changes: number };

export function normalizeWriteResult(result: unknown): WriteResult {
	if (result && typeof result === "object") {
		const row = result as { rowsAffected?: number; changes?: number };
		return { changes: row.rowsAffected ?? row.changes ?? 0 };
	}
	return { changes: 0 };
}

/** Typed Drizzle surface plus `atomic()` for batched writes. */
export type Database = DrizzleSchemaDb & {
	/** Same reference as the merged Drizzle client (explicit access when needed). */
	readonly client: DrizzleSchemaDb;
	atomic<T>(fn: (collect: CollectFn) => Promise<T>): Promise<T>;
};
