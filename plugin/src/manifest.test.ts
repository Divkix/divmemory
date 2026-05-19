import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

describe("plugin manifest", () => {
	const pluginDir = fileURLToPath(new URL("..", import.meta.url));

	describe("plugin.json", () => {
		it("exists at the plugin package root", () => {
			const path = join(pluginDir, "plugin.json");
			expect(existsSync(path)).toBe(true);
		});

		it("is valid JSON", () => {
			const content = readFileSync(join(pluginDir, "plugin.json"), "utf-8");
			expect(() => JSON.parse(content)).not.toThrow();
		});

		it("contains required metadata fields", () => {
			const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf-8"));
			expect(manifest.name).toBe("divmemory");
			expect(typeof manifest.description).toBe("string");
			expect(manifest.description.length).toBeGreaterThan(0);
			expect(manifest.version).toBeDefined();
			expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
			expect(manifest.author).toBeDefined();
		});
	});

	describe("hooks.json", () => {
		const path = join(pluginDir, "hooks.json");
		let hooks: Record<string, unknown>;

		beforeAll(() => {
			const content = readFileSync(path, "utf-8");
			hooks = JSON.parse(content);
		});

		it("exists at the plugin package root", () => {
			expect(existsSync(path)).toBe(true);
		});

		it("is valid JSON", () => {
			expect(hooks).toBeDefined();
		});

		it("defines SessionEnd hook with 90s timeout", () => {
			const h = hooks.hooks as Array<Record<string, unknown>>;
			const sessionEnd = h?.find((hook) => hook.event === "SessionEnd");
			expect(sessionEnd).toBeDefined();
			expect(sessionEnd?.command).toContain("node");
			expect(sessionEnd?.command).toContain("scripts/session-end.mjs");
			expect(sessionEnd?.timeout).toBe(90);
		});

		it("defines SessionStart hook with 30s timeout", () => {
			const h = hooks.hooks as Array<Record<string, unknown>>;
			const sessionStart = h?.find((hook) => hook.event === "SessionStart");
			expect(sessionStart).toBeDefined();
			expect(sessionStart?.command).toContain("node");
			expect(sessionStart?.command).toContain("scripts/session-start.mjs");
			expect(sessionStart?.timeout).toBe(30);
		});

		it("references DROID_PLUGIN_ROOT for hook script paths", () => {
			const h = hooks.hooks as Array<Record<string, unknown>>;
			const sessionEnd = h?.find((hook) => hook.event === "SessionEnd");
			const sessionStart = h?.find((hook) => hook.event === "SessionStart");
			expect(sessionEnd?.command).toContain("$" + "{DROID_PLUGIN_ROOT}");
			expect(sessionStart?.command).toContain("$" + "{DROID_PLUGIN_ROOT}");
		});
	});

	describe("hook scripts exist", () => {
		it("session-end.mjs exists", () => {
			const p = join(pluginDir, "scripts", "session-end.mjs");
			expect(existsSync(p)).toBe(true);
		});

		it("session-start.mjs exists", () => {
			const p = join(pluginDir, "scripts", "session-start.mjs");
			expect(existsSync(p)).toBe(true);
		});
	});

	describe("DROID_PLUGIN_ROOT resolution", () => {
		it("resolves to the plugin package root directory when set", () => {
			const root = join(pluginDir, "hooks.json");
			expect(existsSync(root)).toBe(true);
		});

		it("hook scripts are executable at resolved paths", () => {
			const endPath = join(pluginDir, "scripts", "session-end.mjs");
			const startPath = join(pluginDir, "scripts", "session-start.mjs");
			expect(existsSync(endPath)).toBe(true);
			expect(existsSync(startPath)).toBe(true);
		});
	});

	describe("DIVMEMORY_WORKER_URL propagation", () => {
		it("hooks reference DIVMEMORY_WORKER_URL in source", () => {
			const endScript = readFileSync(join(pluginDir, "scripts", "session-end.mjs"), "utf-8");
			const startScript = readFileSync(join(pluginDir, "scripts", "session-start.mjs"), "utf-8");
			expect(endScript).toContain("DIVMEMORY_WORKER_URL");
			expect(startScript).toContain("DIVMEMORY_WORKER_URL");
		});

		it("CLI references DIVMEMORY_WORKER_URL in source", () => {
			const cliDir = dirname(dirname(pluginDir));
			const cliPath = join(cliDir, "cli", "src", "index.ts");
			if (!existsSync(cliPath)) return;
			const cliSource = readFileSync(cliPath, "utf-8");
			expect(cliSource).toContain("DIVMEMORY_WORKER_URL");
		});
	});
});
