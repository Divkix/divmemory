import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(root, "migrations"));
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.test.jsonc" },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
					},
					vars: {
						DIVMEMORY_API_KEY: "test-cf-api-key",
						FIREWORKS_API_KEY: "test-fireworks-key",
						FIREWORKS_MODEL: "test-model",
					},
				},
			}),
		],
		test: {
			// Exception Policy: This configuration specifically targets integration tests that
			// require the Cloudflare Workers pool environment (Miniflare, bindings, etc.).
			// Non-integration and standard unit tests are co-located in the 'src/' directory
			// and are run via the standard 'vitest.config.ts' configuration to avoid pool overhead.
			include: ["tests/cloudflare/**/*.test.ts"],
			setupFiles: ["./tests/cloudflare/setup.ts"],
		},
	};
});
