import { D1DrizzleAdapter } from "./d1-adapter";
import type { Database } from "./types";

export { createD1Client, D1DrizzleAdapter } from "./d1-adapter";
export { dbClient, resolveDatabase } from "./helpers";
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

export function isDatabase(value: unknown): value is Database {
	return (
		typeof value === "object" &&
		value !== null &&
		"client" in value &&
		"atomic" in value &&
		typeof (value as Database).atomic === "function"
	);
}

/** Production D1 adapter from a Worker binding. */
export function createDatabaseFromEnv(db: D1Database): Database {
	return new D1DrizzleAdapter(db).asDatabase();
}
