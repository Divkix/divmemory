import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pluginRoot = join(root, "plugins", "divmemory");

describe("Factory marketplace plugin shape", () => {
	it("exposes a root marketplace manifest for Droid marketplace add", () => {
		for (const metadataDir of [".factory-plugin", ".claude-plugin"]) {
			const marketplacePath = join(root, metadataDir, "marketplace.json");
			expect(existsSync(marketplacePath)).toBe(true);

			const marketplace = JSON.parse(readFileSync(marketplacePath, "utf-8")) as {
				name?: string;
				description?: string;
				plugins?: Array<{
					name?: string;
					description?: string;
					version?: string;
					source?: string;
					category?: string;
				}>;
			};
			const plugin = marketplace.plugins?.find((entry) => entry.name === "divmemory");
			expect(plugin).toBeDefined();

			expect(marketplace.name).toBe("divmemory");
			expect(marketplace.description).toContain("Persistent");
			expect(plugin).toMatchObject({
				name: "divmemory",
				source: "./plugins/divmemory",
				category: "productivity",
			});
			expect(plugin?.version).toMatch(/^\d+\.\d+\.\d+/);
			expect(existsSync(join(root, plugin?.source ?? "", ".factory-plugin", "plugin.json"))).toBe(
				true,
			);
		}
	});

	it("exposes divmemory under plugins/divmemory with .factory-plugin metadata", () => {
		const manifestPath = join(pluginRoot, ".factory-plugin", "plugin.json");
		expect(existsSync(manifestPath)).toBe(true);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
			name?: string;
			version?: string;
			description?: string;
		};
		expect(manifest.name).toBe("divmemory");
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(manifest.description).toContain("Persistent");
	});

	it("uses Factory hook object schema with command hooks", () => {
		const hooksPath = join(pluginRoot, "hooks", "hooks.json");
		expect(existsSync(hooksPath)).toBe(true);
		const hooks = JSON.parse(readFileSync(hooksPath, "utf-8")) as {
			hooks?: Record<
				string,
				Array<{ hooks?: Array<{ type?: string; command?: string; async?: boolean }> }>
			>;
		};
		const sessionStart = hooks.hooks?.SessionStart?.[0]?.hooks?.[0];
		const sessionEnd = hooks.hooks?.SessionEnd?.[0]?.hooks?.[0];
		expect(sessionStart).toMatchObject({ type: "command", async: false });
		expect(sessionStart?.command).toContain("hooks/session-start-fast.sh");
		expect(sessionEnd).toMatchObject({ type: "command", async: false });
		expect(sessionEnd?.command).toContain("hooks/session-end.mjs");
	});

	it("ships command frontmatter and memory skill in marketplace plugin", () => {
		const command = readFileSync(join(pluginRoot, "commands", "memory.md"), "utf-8");
		const skill = readFileSync(join(pluginRoot, "skills", "memory", "SKILL.md"), "utf-8");
		expect(command.startsWith("---\n")).toBe(true);
		expect(command).toContain("description:");
		expect(command).toContain("POST /memories");
		expect(skill).toContain("POST /memories");
		expect(skill).toContain("GET /status");
	});

	it("keeps marketplace hook scripts self-contained inside plugins/divmemory", () => {
		const startScript = readFileSync(join(pluginRoot, "hooks", "session-start.mjs"), "utf-8");
		const endScript = readFileSync(join(pluginRoot, "hooks", "session-end.mjs"), "utf-8");
		const startFastScript = readFileSync(
			join(pluginRoot, "hooks", "session-start-fast.sh"),
			"utf-8",
		);
		expect(startScript).not.toContain("../../../plugin/");
		expect(endScript).not.toContain("../../../plugin/");
		expect(startFastScript).not.toContain("../../../plugin/");
		expect(startScript).toContain("./runtime.mjs");
		expect(endScript).toContain("./runtime.mjs");
		expect(startFastScript).toContain("session-start.mjs");
		expect(startFastScript).toContain("JSON.parse");
		expect(startFastScript).toContain("encodeURIComponent");
		expect(startFastScript).toContain("failed to encode project cache key");
	});
});
