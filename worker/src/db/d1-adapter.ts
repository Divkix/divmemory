import { drizzle } from "drizzle-orm/d1";
import * as schema from "../schema";
import type { AtomicStatement, CollectFn, Database, DrizzleSchemaDb } from "./types";
import { wrapDatabase } from "./wrap";

/** D1 batch() allows at most 100 statements per call. */
const D1_BATCH_LIMIT = 100;

export function createD1Client(d1: D1Database): DrizzleSchemaDb {
	return drizzle(d1, { schema }) as unknown as DrizzleSchemaDb;
}

export class D1DrizzleAdapter {
	readonly client: DrizzleSchemaDb;

	constructor(d1: D1Database) {
		this.client = createD1Client(d1);
	}

	asDatabase(): Database {
		return wrapDatabase(this);
	}

	async atomic<T>(fn: (collect: CollectFn) => Promise<T>): Promise<T> {
		const stmts: AtomicStatement[] = [];
		const collect: CollectFn = (q) => stmts.push(q);
		const result = await fn(collect);
		if (stmts.length > 0) {
			if (stmts.length > D1_BATCH_LIMIT) {
				throw new Error(
					`D1 batch limit exceeded: ${stmts.length} statements (max ${D1_BATCH_LIMIT})`,
				);
			}
			const batchable = this.client as DrizzleSchemaDb & {
				batch: (batch: AtomicStatement[]) => Promise<unknown[]>;
			};
			await batchable.batch(stmts);
		}
		return result;
	}
}
