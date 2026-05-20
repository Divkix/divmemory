import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pluginRoot = join(root, "plugins", "divmemory");

describe("Factory marketplace plugin shape", () => {
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
		expect(sessionStart?.command).toContain("hooks/session-start.mjs");
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
		expect(startScript).not.toContain("../../../plugin/");
		expect(endScript).not.toContain("../../../plugin/");
		expect(startScript).toContain("./runtime.mjs");
		expect(endScript).toContain("./runtime.mjs");
	});
});
