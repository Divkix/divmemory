import type { Database as BunDatabase } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../schema";
import type { AtomicStatement, CollectFn, Database, DrizzleSchemaDb } from "./types";
import { wrapDatabase } from "./wrap";

export function createBunSqliteClient(sqlite: BunDatabase): DrizzleSchemaDb {
	return drizzle(sqlite, { schema }) as DrizzleSchemaDb;
}

function isDrizzleClient(source: BunDatabase | DrizzleSchemaDb): source is DrizzleSchemaDb {
	return typeof (source as DrizzleSchemaDb).select === "function";
}

export class BunSQLiteAdapter {
	readonly client: DrizzleSchemaDb;

	constructor(source: BunDatabase | DrizzleSchemaDb) {
		this.client = isDrizzleClient(source) ? source : createBunSqliteClient(source);
	}

	asDatabase(): Database {
		return wrapDatabase(this);
	}

	async atomic<T>(fn: (collect: CollectFn) => Promise<T>): Promise<T> {
		const transactional = this.client as DrizzleSchemaDb & {
			transaction: <U>(inner: (tx: DrizzleSchemaDb) => Promise<U>) => Promise<U>;
		};
		return transactional.transaction(async () => {
			const stmts: AtomicStatement[] = [];
			const collect: CollectFn = (q) => stmts.push(q);
			const result = await fn(collect);
			for (const q of stmts) {
				await q.run();
			}
			return result;
		});
	}
}
