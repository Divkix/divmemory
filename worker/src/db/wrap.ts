import type { CollectFn, Database, DrizzleSchemaDb } from "./types";

interface AtomicCapable {
	readonly client: DrizzleSchemaDb;
	atomic<T>(fn: (collect: CollectFn) => Promise<T>): Promise<T>;
}

/** Merge typed Drizzle methods onto the Database surface (`db.select()` works). */
export function wrapDatabase(adapter: AtomicCapable): Database {
	return Object.assign(adapter.client, {
		client: adapter.client,
		atomic: adapter.atomic.bind(adapter),
	}) as Database;
}
