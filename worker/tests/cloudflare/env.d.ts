import type { D1Migration } from "cloudflare:test";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {
		TEST_MIGRATIONS: D1Migration[];
	}
}

interface Env {
	DB: D1Database;
	DIVMEMORY_API_KEY: string;
	FIREWORKS_API_KEY?: string;
	FIREWORKS_MODEL?: string;
}
