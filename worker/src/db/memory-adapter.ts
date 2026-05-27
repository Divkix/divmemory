import { Database as BunDatabase } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { BunSQLiteAdapter } from "./bun-sqlite-adapter";
import type { Database } from "./types";

/** Fast in-memory SQLite-backed adapter (no D1 / no persisted file). */
export class InMemoryAdapter extends BunSQLiteAdapter {
	constructor() {
		const sqlite = new BunDatabase(":memory:");
		sqlite.exec("PRAGMA foreign_keys = ON;");
		super(sqlite);

		let migrationsFolder = join(process.cwd(), "worker/migrations");
		if (!existsSync(migrationsFolder)) {
			migrationsFolder = join(process.cwd(), "migrations");
		}
		migrate(this.client, { migrationsFolder });
	}
}

export function createInMemoryDatabase(): Database {
	return new InMemoryAdapter().asDatabase();
}
