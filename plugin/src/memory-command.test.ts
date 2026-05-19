import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const pluginDir = fileURLToPath(new URL("..", import.meta.url));
const commandsPath = join(pluginDir, "commands", "memory.md");
const skillsPath = join(pluginDir, "skills", "memory", "SKILL.md");
const hooksPath = join(pluginDir, "hooks.json");

let commandsContent: string;
let skillsContent: string;

beforeAll(() => {
	commandsContent = readFileSync(commandsPath, "utf-8");
	skillsContent = readFileSync(skillsPath, "utf-8");
});

// ============================================================
// VAL-PLUGIN-059–082: /memory subcommand documentation
// ============================================================
describe("/memory slash command", () => {
	describe("VAL-PLUGIN-059: /memory show — GETs /context and prints to Droid context", () => {
		it("documents GET /context usage in commands/memory.md", () => {
			expect(commandsContent).toMatch(/GET .*\/context/);
			expect(commandsContent).toContain("show");
		});
		it("guides agent to print markdown context block in SKILL.md", () => {
			expect(skillsContent).toContain("/memory show");
			expect(skillsContent).toContain("GET /context");
			expect(skillsContent).toContain("Print the returned markdown");
		});
	});

	describe("VAL-PLUGIN-060: /memory show — Handles empty context (no memories yet)", () => {
		it("documents empty-context handling in commands/memory.md", () => {
			expect(commandsContent).toContain("no memories");
		});
		it("guides agent to print no-memories message in SKILL.md", () => {
			expect(skillsContent).toMatch(/No memories/);
		});
	});

	describe("VAL-PLUGIN-061: /memory show — Handles Worker API error", () => {
		it("documents error handling for show in commands/memory.md", () => {
			expect(commandsContent).toContain("Error handling");
			expect(commandsContent).toContain("Worker");
		});
		it("guides agent to report error gracefully in SKILL.md", () => {
			expect(skillsContent).toContain("Error handling");
		});
	});

	describe("VAL-PLUGIN-062: /memory forget — Searches memories via GET /memories?search", () => {
		it("documents search via GET /memories in commands/memory.md", () => {
			expect(commandsContent).toMatch(/GET .*\/memories.*search/);
			expect(commandsContent).toContain("forget");
		});
		it("guides agent to call GET /memories?search in SKILL.md", () => {
			expect(skillsContent).toContain("/memory forget");
			expect(skillsContent).toContain("GET /memories");
			expect(skillsContent).toContain("search");
		});
	});

	describe("VAL-PLUGIN-063: /memory forget — Confirms with user before deleting", () => {
		it("documents mandatory confirmation in commands/memory.md", () => {
			expect(commandsContent).toContain("confirm");
			expect(commandsContent).toMatch(/ask.*confirm/i);
		});
		it("guides agent to ask for confirmation in SKILL.md", () => {
			expect(skillsContent).toContain("ask for confirmation");
		});
	});

	describe("VAL-PLUGIN-064: /memory forget — DELETEs confirmed memory by ID", () => {
		it("documents DELETE /memories/:id in commands/memory.md", () => {
			expect(commandsContent).toMatch(/DELETE.*memories.*id/);
		});
		it("guides agent to call DELETE in SKILL.md", () => {
			expect(skillsContent).toContain("DELETE /memories");
		});
	});

	describe("VAL-PLUGIN-065: /memory forget — Curated facts are soft-archived", () => {
		it("documents curated soft-archive in commands/memory.md", () => {
			expect(commandsContent).toContain("archived");
			expect(commandsContent).toContain("curated");
		});
		it("guides agent about archive behavior in SKILL.md", () => {
			expect(skillsContent).toContain("archived");
			expect(skillsContent).toMatch(/status.*archived/);
		});
	});

	describe("VAL-PLUGIN-066: /memory forget — Auto-extracted facts are hard-deleted", () => {
		it("documents hard-delete for auto-extracted in commands/memory.md", () => {
			expect(commandsContent).toContain("hard-deleted");
			expect(commandsContent).toContain("auto-extracted");
		});
		it("guides agent about hard-delete behavior in SKILL.md", () => {
			expect(skillsContent).toContain("hard-deleted");
		});
	});

	describe("VAL-PLUGIN-067: /memory forget — No matches found", () => {
		it("documents no-matches message in commands/memory.md", () => {
			expect(commandsContent).toContain("No matching memories found");
		});
		it("guides agent to print no-matches message in SKILL.md", () => {
			expect(skillsContent).toContain("No matching memories found");
		});
	});

	describe("VAL-PLUGIN-068: /memory forget — Multiple ambiguous matches", () => {
		it("documents disambiguation for multiple matches in commands/memory.md", () => {
			expect(commandsContent).toContain("multiple");
			expect(commandsContent).toContain("pick");
		});
		it("guides agent to list matches with IDs in SKILL.md", () => {
			expect(skillsContent).toContain("show the user each match");
		});
	});

	describe("VAL-PLUGIN-069: /memory forget — Handles search API error", () => {
		it("documents search error handling in commands/memory.md", () => {
			expect(commandsContent).toContain("Error handling");
		});
		it("guides agent to report search errors in SKILL.md", () => {
			expect(skillsContent).toContain("Error handling");
		});
	});

	describe("VAL-PLUGIN-070: /memory forget — Handles delete API error", () => {
		it("documents delete error handling in commands/memory.md", () => {
			expect(commandsContent).toContain("Error handling");
		});
		it("guides agent to report delete errors in SKILL.md", () => {
			expect(skillsContent).toContain("Error handling");
		});
	});

	describe("VAL-PLUGIN-071: /memory add — POSTs curated fact insertion", () => {
		it("documents POST for curated fact in commands/memory.md", () => {
			expect(commandsContent).toContain("add");
			expect(commandsContent).toContain("curated");
			expect(commandsContent).toContain("POST");
		});
		it("guides agent to POST a fact in SKILL.md", () => {
			expect(skillsContent).toContain("/memory add");
			expect(skillsContent).toContain("POST");
			expect(skillsContent).toContain("curated");
		});
	});

	describe("VAL-PLUGIN-072: /memory add — Defaults topic to general", () => {
		it("documents default topic in commands/memory.md", () => {
			expect(commandsContent).toContain("general");
			expect(commandsContent).toMatch(/default.*topic.*general/);
		});
		it("guides agent to default to general in SKILL.md", () => {
			expect(skillsContent).toMatch(/Default topic.*\bgeneral\b/);
		});
	});

	describe("VAL-PLUGIN-073: /memory add — Runs through dedup pipeline", () => {
		it("documents dedup in commands/memory.md", () => {
			expect(commandsContent).toContain("dedup");
			expect(commandsContent).toContain("Jaccard");
		});
		it("guides agent about dedup in SKILL.md", () => {
			expect(skillsContent).toContain("dedup");
			expect(skillsContent).toContain("Jaccard");
		});
	});

	describe("VAL-PLUGIN-074: /memory add — Does not overwrite existing similar fact content", () => {
		it("documents content preservation in commands/memory.md", () => {
			expect(commandsContent).toContain("updated_at");
			expect(commandsContent).toContain("NOT");
		});
		it("guides agent about not overwriting in SKILL.md", () => {
			expect(skillsContent).toContain("NOT overwritten");
		});
	});

	describe("VAL-PLUGIN-075: /memory add — Inserts new fact when no similar exists", () => {
		it("documents new insertion in commands/memory.md", () => {
			expect(commandsContent).toContain("new memory row");
		});
		it("guides agent about new insertion in SKILL.md", () => {
			expect(skillsContent).toContain("new memory row");
		});
	});

	describe("VAL-PLUGIN-076: /memory add — Handles API error", () => {
		it("documents add error handling in commands/memory.md", () => {
			expect(commandsContent).toContain("Error handling");
		});
		it("guides agent to report add errors in SKILL.md", () => {
			expect(skillsContent).toContain("Error handling");
		});
	});

	describe("VAL-PLUGIN-077: /memory consolidate — Triggers consolidation via POST /consolidate", () => {
		it("documents POST /consolidate in commands/memory.md", () => {
			expect(commandsContent).toContain("consolidate");
			expect(commandsContent).toMatch(/POST.*\/consolidate/);
		});
		it("guides agent to POST consolidate in SKILL.md", () => {
			expect(skillsContent).toContain("/memory consolidate");
			expect(skillsContent).toContain("POST /consolidate");
		});
	});

	describe("VAL-PLUGIN-078: /memory consolidate — Reports consolidation result to user", () => {
		it("documents result reporting in commands/memory.md", () => {
			expect(commandsContent).toContain("Reports the result");
		});
		it("guides agent to report result in SKILL.md", () => {
			expect(skillsContent).toContain("Report the result");
		});
	});

	describe("VAL-PLUGIN-079: /memory consolidate — Handles no sessions to consolidate", () => {
		it("documents nothing-to-consolidate handling in commands/memory.md", () => {
			expect(commandsContent).toContain("Nothing to consolidate");
		});
		it("guides agent to print nothing-to-consolidate in SKILL.md", () => {
			expect(skillsContent).toContain("Nothing to consolidate");
		});
	});

	describe("VAL-PLUGIN-080: /memory consolidate — Handles API error", () => {
		it("documents consolidate error handling in commands/memory.md", () => {
			expect(commandsContent).toContain("Error handling");
		});
		it("guides agent to report consolidate errors in SKILL.md", () => {
			expect(skillsContent).toContain("Error handling");
		});
	});

	describe("VAL-PLUGIN-081: /memory status — Shows session count, fact count, last sync", () => {
		it("documents status fields in commands/memory.md", () => {
			expect(commandsContent).toContain("status");
			expect(commandsContent).toContain("Session count");
			expect(commandsContent).toContain("fact count");
			expect(commandsContent).toContain("last sync");
		});
		it("guides agent to display stats in SKILL.md", () => {
			expect(skillsContent).toContain("/memory status");
			expect(skillsContent).toContain("Session count");
			expect(skillsContent).toContain("Active fact count");
			expect(skillsContent).toContain("Last sync");
		});
	});

	describe("VAL-PLUGIN-082: /memory status — Handles API error", () => {
		it("documents status error handling in commands/memory.md", () => {
			expect(commandsContent).toContain("Error handling");
		});
		it("guides agent to report status errors in SKILL.md", () => {
			expect(skillsContent).toContain("Error handling");
		});
	});
});

// ============================================================
// VAL-PLUGIN-083–086: Auth, URL, help, unknown subcommand
// ============================================================
describe("/memory command infrastructure", () => {
	describe("VAL-PLUGIN-083: All /memory commands use DIVMEMORY_API_KEY for auth", () => {
		it("commands/memory.md documents Bearer auth with DIVMEMORY_API_KEY", () => {
			expect(commandsContent).toContain("Authorization: Bearer");
			expect(commandsContent).toContain("DIVMEMORY_API_KEY");
		});
		it("skills/...SKILL.md references Bearer auth", () => {
			expect(skillsContent).toMatch(/Authorization: Bearer/);
			expect(skillsContent).toContain("DIVMEMORY_API_KEY");
		});
		it("hooks.json is present (provides SessionStart/End contexts that supply project_id)", () => {
			expect(existsSync(hooksPath)).toBe(true);
		});
	});

	describe("VAL-PLUGIN-084: All /memory commands respect DIVMEMORY_WORKER_URL", () => {
		it("commands/memory.md documents DIVMEMORY_WORKER_URL", () => {
			expect(commandsContent).toContain("DIVMEMORY_WORKER_URL");
		});
		it("skills/...SKILL.md references DIVMEMORY_WORKER_URL", () => {
			expect(skillsContent).toContain("DIVMEMORY_WORKER_URL");
		});
	});

	describe("VAL-PLUGIN-085: /memory command help — explains usage when no subcommand", () => {
		it("commands/memory.md has a top-level heading", () => {
			expect(commandsContent).toMatch(/^#\s/m);
		});
		it("skills/...SKILL.md documents the full command syntax", () => {
			expect(skillsContent).toContain("To manually save");
			expect(skillsContent).toContain("To view");
		});
	});

	describe("VAL-PLUGIN-086: /memory handles unknown subcommand", () => {
		it("commands/memory.md lists only valid subcommands", () => {
			// show, forget, add, consolidate, status should be the documented ones
			const subcommandList = commandsContent.match(/`\/memory\s+(\w+)`/g) || [];
			const validSubcommands = new Set(["show", "forget", "add", "consolidate", "status"]);
			for (const sub of subcommandList) {
				const name = sub.replace(/^`\/memory\s+/, "").replace(/`$/, "");
				expect(validSubcommands.has(name)).toBe(true);
			}
		});
	});
});

// ============================================================
// VAL-PLUGIN-115–117: Plugin structural checks
// ============================================================
describe("plugin structural", () => {
	describe("VAL-PLUGIN-115: DROID_PLUGIN_ROOT environment variable resolution", () => {
		it("hooks.json references DROID_PLUGIN_ROOT via $ brace syntax", () => {
			const hooksContent = readFileSync(hooksPath, "utf-8");
			expect(hooksContent).toContain("$" + "{DROID_PLUGIN_ROOT}");
		});
	});

	describe("VAL-PLUGIN-116: hooks.json structure and timeout values", () => {
		it("is valid JSON with hooks array", () => {
			const data = JSON.parse(readFileSync(hooksPath, "utf-8"));
			expect(Array.isArray(data.hooks)).toBe(true);
		});
		it("SessionEnd hook has 90-second timeout", () => {
			const data = JSON.parse(readFileSync(hooksPath, "utf-8"));
			const se = data.hooks.find((h: { event: string }) => h.event === "SessionEnd");
			expect(se.timeout).toBe(90);
		});
		it("SessionStart hook has 30-second timeout", () => {
			const data = JSON.parse(readFileSync(hooksPath, "utf-8"));
			const ss = data.hooks.find((h: { event: string }) => h.event === "SessionStart");
			expect(ss.timeout).toBe(30);
		});
	});

	describe("VAL-PLUGIN-117: plugin.json manifest validation", () => {
		it("plugin.json exists and is valid JSON", () => {
			const pluginJsonPath = join(pluginDir, "plugin.json");
			expect(existsSync(pluginJsonPath)).toBe(true);
			const data = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
			expect(data.name).toBe("divmemory");
			expect(typeof data.description).toBe("string");
		});
	});
});
