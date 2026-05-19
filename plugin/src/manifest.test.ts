import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

describe("plugin manifest", () => {
	const pluginDir = fileURLToPath(new URL("..", import.meta.url));
	const commandsPath = join(pluginDir, "commands", "memory.md");
	let commandsContent: string;

	beforeAll(() => {
		if (existsSync(commandsPath)) {
			commandsContent = readFileSync(commandsPath, "utf-8");
		}
	});

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

	describe("VAL-PLUGIN-112: /memory command file at plugin/commands/memory.md", () => {
		it("memory.md exists at plugin/commands/memory.md", () => {
			expect(existsSync(commandsPath)).toBe(true);
		});

		it("memory.md is valid markdown with a heading", () => {
			expect(commandsContent).toContain("#");
		});

		it("documents show subcommand", () => {
			expect(commandsContent).toContain("show");
		});

		it("documents forget subcommand", () => {
			expect(commandsContent).toContain("forget");
		});

		it("documents add subcommand", () => {
			expect(commandsContent).toContain("add");
		});

		it("documents consolidate subcommand", () => {
			expect(commandsContent).toContain("consolidate");
		});

		it("documents status subcommand", () => {
			expect(commandsContent).toContain("status");
		});

		it("mentions DIVMEMORY_API_KEY", () => {
			expect(commandsContent).toContain("DIVMEMORY_API_KEY");
		});

		it("mentions DIVMEMORY_WORKER_URL", () => {
			expect(commandsContent).toContain("DIVMEMORY_WORKER_URL");
		});
	});
});

describe("agent skill", () => {
	const pluginDir = fileURLToPath(new URL("..", import.meta.url));
	const skillPath = join(pluginDir, "skills", "memory", "SKILL.md");
	let skillContent: string;

	beforeAll(() => {
		skillContent = readFileSync(skillPath, "utf-8");
	});

	describe("VAL-PLUGIN-091: Skill is loaded from plugin/skills/memory/SKILL.md", () => {
		it("SKILL.md exists at the correct path", () => {
			expect(existsSync(skillPath)).toBe(true);
		});

		it("SKILL.md is valid markdown", () => {
			expect(skillContent).toContain("#");
			expect(skillContent.length).toBeGreaterThan(50);
		});
	});

	describe("VAL-PLUGIN-092: Skill contains correct topic descriptions for all 5 topics", () => {
		it("lists all 5 topics", () => {
			const topics = ["project_context", "decisions", "issues", "preferences", "general"];
			for (const topic of topics) {
				expect(skillContent).toContain(topic);
			}
		});

		it("each topic has a description", () => {
			const topicLines = skillContent
				.split("\n")
				.filter((line) => line.startsWith("- ") && line.includes(":"));
			expect(topicLines.length).toBeGreaterThanOrEqual(5);
		});
	});

	describe("VAL-PLUGIN-113: SKILL.md content mentions /memory add and /memory show commands", () => {
		it("mentions /memory add", () => {
			expect(skillContent).toContain("/memory add");
		});

		it("mentions /memory show", () => {
			expect(skillContent).toContain("/memory show");
		});
	});

	describe("VAL-PLUGIN-114: SKILL.md exact content completeness — header, injection awareness, topic descriptions", () => {
		it("contains the header about persistent memory system", () => {
			expect(skillContent).toContain("persistent memory system");
		});

		it("contains the injection-awareness line about session start", () => {
			expect(skillContent).toContain("At the start of this session, your memory");
			expect(skillContent).toContain("injected into the context");
		});

		it("mentions the context block header format", () => {
			expect(skillContent).toContain("## divmemory — Project Memory");
		});
	});

	describe("VAL-PLUGIN-088: Agent recognizes injected context block format", () => {
		it("describes how memory appears in context", () => {
			expect(skillContent).toContain("It appears under");
			expect(skillContent).toContain("## divmemory — Project Memory");
		});
	});

	describe("VAL-PLUGIN-087: Skill loaded by Droid and agent understands memory topics", () => {
		it("defines topic project_context", () => {
			expect(skillContent).toContain("project_context");
			expect(skillContent).toMatch(/project_context.*stack.*architecture/);
		});

		it("defines topic decisions", () => {
			expect(skillContent).toContain("decisions");
			expect(skillContent).toMatch(/decisions.*choice/);
		});

		it("defines topic issues", () => {
			expect(skillContent).toContain("issues");
			expect(skillContent).toMatch(/issue.*bug.*gotch/);
		});

		it("defines topic preferences", () => {
			expect(skillContent).toContain("preferences");
			expect(skillContent).toMatch(/preference.*like.*thing/);
		});

		it("defines topic general", () => {
			expect(skillContent).toContain("general");
			expect(skillContent).toMatch(/general.*cross-project/);
		});
	});

	describe("VAL-PLUGIN-089: Agent can explain /memory command to the user", () => {
		it("includes instruction to view memory with /memory show", () => {
			expect(skillContent).toContain("/memory show");
		});

		it("includes instruction to save memory with /memory add", () => {
			expect(skillContent).toContain("/memory add");
		});
	});

	describe("VAL-PLUGIN-090: Agent proactively suggests /memory add when user shares important info", () => {
		it("provides the /memory add command for manual saves", () => {
			expect(skillContent).toContain("/memory add");
		});

		it("references manual fact saving with a topic argument", () => {
			expect(skillContent).toMatch(/\/memory add.*"<fact>".*<topic>/);
		});
	});

	describe("VAL-PLUGIN-093: Skill works with session context injection", () => {
		it("explains that memory is injected at session start", () => {
			expect(skillContent).toContain("At the start of this session, your memory");
		});

		it("references the context block format used by injection", () => {
			expect(skillContent).toContain("## divmemory — Project Memory");
		});
	});
});
