import type { D1Database } from "@cloudflare/workers-types";
import { D1DrizzleAdapter } from "./d1-adapter";
import type { Database } from "./types";

/** Shared helper for Hono routes: injected test DB or production D1 adapter. */
export function resolveDatabase(c: { env: { DB: D1Database } }, db?: Database): Database {
	return db ?? new D1DrizzleAdapter(c.env.DB).asDatabase();
}

/** Drizzle client shorthand for route handlers. */
export function dbClient(db: Database) {
	return db.client;
}
