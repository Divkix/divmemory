import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

export type DbLike = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, unknown>>;

/**
 * Atomic DB writes helper.
 *
 * D1: uses db.batch() for true atomicity (D1 auto-commit ignores raw BEGIN/COMMIT)
 * bun-sqlite: uses db.transaction() via Drizzle's SQLite transaction API
 */
export async function runAtomic<T>(
	db: DbLike,
	fn: (dbOrTx: DbLike, addStmt: (q: { run: () => unknown }) => void) => Promise<T>,
): Promise<T> {
	// Detect D1 by presence of .batch() method
	if ("batch" in db && typeof (db as unknown as { batch: unknown }).batch === "function") {
		const stmts: Array<{ run: () => unknown }> = [];
		const addStmt = (q: { run: () => unknown }) => stmts.push(q);
		const result = await fn(db, addStmt);
		if (stmts.length > 0) {
			await (db as unknown as { batch: (batch: unknown[]) => Promise<unknown[]> }).batch(stmts);
		}
		return result;
	}
	// bun-sqlite: execute in Drizzle transaction; addStmt calls .run() immediately
	return (
		db as unknown as { transaction: <U>(fn: (tx: DbLike) => Promise<U>) => Promise<U> }
	).transaction(async (tx) => {
		const addStmt = (q: { run: () => unknown }) => {
			q.run();
		};
		return await fn(tx, addStmt);
	});
}
