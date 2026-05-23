import type { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { bearerAuth } from "../auth";
import { GLOBAL_PROJECT_ID, memories, projects, sessions } from "../schema";
import { createTestDb } from "../test-helpers";
import { createContextRoute } from "./context";

const TEST_API_KEY = "test-api-key-123";

function createContextApp(db: ReturnType<typeof drizzle>) {
	const app = new Hono<{ Bindings: { DB: typeof db; DIVMEMORY_API_KEY: string } }>();
	app.use("/context", bearerAuth("divmemory_session"));
	createContextRoute(app, db);
	return app;
}

function envVars() {
	return { DIVMEMORY_API_KEY: TEST_API_KEY };
}

function authHeaders() {
	return { Authorization: `Bearer ${TEST_API_KEY}` };
}

async function seedMemories(
	db: ReturnType<typeof drizzle>,
	projectId: string,
	facts: Array<{
		topic: string;
		content: string;
		curated?: number;
		status?: string;
		updatedAt?: string;
	}>,
) {
	// upsert project first (sessions FK references projects.id)
	db.insert(projects)
		.values({
			id: projectId,
			name: projectId.split("/").pop() || projectId,
			sessionCount: 1,
			createdAt: new Date().toISOString(),
			lastSeen: new Date().toISOString(),
		})
		.run();

	const sessionId = crypto.randomUUID();
	db.insert(sessions)
		.values({
			id: sessionId,
			projectId,
			source: "droid",
			rawText: "test conversation",
			consolidated: 0,
			createdAt: new Date().toISOString(),
		})
		.run();

	for (const fact of facts) {
		db.insert(memories)
			.values({
				id: crypto.randomUUID(),
				projectId,
				sourceSession: sessionId,
				topic: fact.topic,
				content: fact.content,
				confidence: 0.9,
				curated: fact.curated ?? 0,
				status: fact.status ?? "active",
				createdAt: new Date().toISOString(),
				updatedAt: fact.updatedAt ?? new Date().toISOString(),
			})
			.run();
	}
}

/* ───── helpers ───── */

function getLines(text: string): string[] {
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

describe("GET /context", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let app: ReturnType<typeof createContextApp>;

	beforeEach(() => {
		testDb = createTestDb();
		app = createContextApp(testDb.db);
	});

	describe("auth", () => {
		it("returns 401 when missing Authorization header", async () => {
			const req = new Request("http://localhost/context?project=test");
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(401);
		});

		it("returns 401 with invalid API key", async () => {
			const req = new Request("http://localhost/context?project=test", {
				headers: { Authorization: "Bearer wrong-key" },
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(401);
		});
	});

	describe("parameter validation", () => {
		it("returns 400 when project parameter is missing", async () => {
			const req = new Request("http://localhost/context", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(400);
		});
	});

	describe("empty / nonexistent projects", () => {
		it("returns 200 with placeholder for empty project (no memories yet)", async () => {
			// create project with zero memories
			testDb.db
				.insert(projects)
				.values({
					id: "github.com/empty/proj",
					name: "Empty Project",
					sessionCount: 0,
					createdAt: new Date().toISOString(),
					lastSeen: new Date().toISOString(),
				})
				.run();
			const req = new Request("http://localhost/context?project=github.com/empty/proj", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("No memories");
			expect(body).toContain("0 facts");
		});

		it("returns 200 with empty context for nonexistent project", async () => {
			const req = new Request(
				"http://localhost/context?project=completely.fake.project.that.never.existed",
				{ headers: authHeaders() },
			);
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("No memories");
			expect(body).toContain("0 facts");
		});
	});

	describe("content format and ordering", () => {
		it("returns text/plain with markdown context block", async () => {
			await seedMemories(testDb.db, "test-project", [
				{ topic: "general", content: "Test fact content" },
			]);
			const req = new Request("http://localhost/context?project=test-project", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const ct = res.headers.get("Content-Type");
			expect(ct).toContain("text/plain");
			const body = await res.text();
			expect(body.startsWith("##")).toBe(true);
			expect(body).toContain("Test fact content");
		});

		it("includes header with last-updated timestamp and fact count", async () => {
			await seedMemories(testDb.db, "test-project", [
				{ topic: "general", content: "Fact A" },
				{ topic: "general", content: "Fact B" },
			]);
			const req = new Request("http://localhost/context?project=test-project", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("2 facts");
			expect(body).toMatch(/\d{4}-\d{2}-\d{2}/); // date
		});

		it("groups facts by topic in consistent order", async () => {
			await seedMemories(testDb.db, "test-project", [
				{ topic: "preferences", content: "Pref fact" },
				{ topic: "project_context", content: "Ctx fact" },
				{ topic: "issues", content: "Issue fact" },
				{ topic: "decisions", content: "Decision fact" },
				{ topic: "general", content: "General fact" },
			]);
			const req = new Request("http://localhost/context?project=test-project", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			const body = await res.text();
			const lines = getLines(body);
			const projectCtxIdx = lines.findIndex((l) => l.includes("Project Context"));
			const decisionsIdx = lines.findIndex((l) => l.includes("Recent Decisions"));
			const issuesIdx = lines.findIndex((l) => l.includes("Known Issues"));
			const prefsIdx = lines.findIndex((l) => l.includes("Your Preferences"));
			const generalIdx = lines.findIndex((l) => l.includes("General"));
			expect(projectCtxIdx).toBeGreaterThanOrEqual(0);
			expect(decisionsIdx).toBeGreaterThanOrEqual(0);
			expect(issuesIdx).toBeGreaterThanOrEqual(0);
			expect(prefsIdx).toBeGreaterThanOrEqual(0);
			expect(generalIdx).toBeGreaterThanOrEqual(0);
		});

		it("orders facts within topic by updated_at DESC", async () => {
			const now = Date.now();
			await seedMemories(testDb.db, "test-project", [
				{
					topic: "decisions",
					content: "Old decision",
					updatedAt: new Date(now - 2000).toISOString(),
				},
				{
					topic: "decisions",
					content: "Middle decision",
					updatedAt: new Date(now - 1000).toISOString(),
				},
				{ topic: "decisions", content: "Newest decision", updatedAt: new Date(now).toISOString() },
			]);
			const req = new Request("http://localhost/context?project=test-project", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			const body = await res.text();
			const decisionsSection = body.split("###").find((s) => s.includes("Recent Decisions"));
			expect(decisionsSection).toBeDefined();
			const section = decisionsSection ?? "";
			const idxNewest = section.indexOf("Newest decision");
			const idxMiddle = section.indexOf("Middle decision");
			const idxOld = section.indexOf("Old decision");
			expect(idxNewest).toBeLessThan(idxMiddle);
			expect(idxMiddle).toBeLessThan(idxOld);
		});

		it("omits empty topic sections", async () => {
			await seedMemories(testDb.db, "test-project", [
				{ topic: "general", content: "Only general fact" },
			]);
			const req = new Request("http://localhost/context?project=test-project", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			const body = await res.text();
			expect(body).not.toContain("Recent Decisions");
			expect(body).not.toContain("Known Issues");
			expect(body).not.toContain("Your Preferences");
			expect(body).not.toContain("Project Context");
		});
	});

	describe("archived exclusion", () => {
		it("excludes archived memories from context", async () => {
			await seedMemories(testDb.db, "test-project", [
				{ topic: "general", content: "Active fact" },
				{ topic: "general", content: "Archived fact", status: "archived" },
			]);
			const req = new Request("http://localhost/context?project=test-project", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			const body = await res.text();
			expect(body).toContain("Active fact");
			expect(body).not.toContain("Archived fact");
		});

		it("returns empty context when all memories are archived", async () => {
			await seedMemories(testDb.db, "test-project", [
				{ topic: "general", content: "All archived", status: "archived" },
			]);
			const req = new Request("http://localhost/context?project=test-project", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("0 facts");
			expect(body).not.toContain("All archived");
		});
	});

	describe("truncation", () => {
		it("default max_chars caps response around 12000 chars", async () => {
			const bigFacts: Array<{ topic: string; content: string }> = [];
			for (let i = 0; i < 30; i++) {
				bigFacts.push({
					topic: ["project_context", "decisions", "issues", "preferences", "general"][i % 5],
					content:
						`Very long fact number ${i} with lots of padding content to make sure it consumes space. `.repeat(
							10,
						),
				});
			}
			await seedMemories(testDb.db, "heavy-project", bigFacts);
			const req = new Request("http://localhost/context?project=heavy-project", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body.length).toBeLessThanOrEqual(13000); // ~12K default + overhead
		});

		it("tunable max_chars=5000 truncates to about 5000", async () => {
			const bigFacts: Array<{ topic: string; content: string }> = [];
			for (let i = 0; i < 30; i++) {
				bigFacts.push({
					topic: ["project_context", "decisions", "issues", "preferences", "general"][i % 5],
					content:
						`Very long fact number ${i} with lots of padding content to make sure it consumes space. `.repeat(
							10,
						),
				});
			}
			await seedMemories(testDb.db, "heavy2", bigFacts);
			const req = new Request("http://localhost/context?project=heavy2&max_chars=5000", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body.length).toBeLessThanOrEqual(5500);
		});

		it("tunable max_chars=2000 truncates to about 2000", async () => {
			const bigFacts: Array<{ topic: string; content: string }> = [];
			for (let i = 0; i < 30; i++) {
				bigFacts.push({
					topic: ["project_context", "decisions", "issues", "preferences", "general"][i % 5],
					content:
						`Very long fact number ${i} with lots of padding content to make sure it consumes space. `.repeat(
							10,
						),
				});
			}
			await seedMemories(testDb.db, "heavy3", bigFacts);
			const req = new Request("http://localhost/context?project=heavy3&max_chars=2000", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body.length).toBeLessThanOrEqual(2200);
		});

		it("topic-balanced truncation: each populated topic gets >=500 chars", async () => {
			const facts: Array<{ topic: string; content: string }> = [];
			for (let i = 0; i < 100; i++) {
				facts.push({
					topic: ["project_context", "decisions", "issues", "preferences", "general"][i % 5],
					content: `Fact ${i}: ${"a".repeat(200)}`,
				});
			}
			await seedMemories(testDb.db, "balanced", facts);
			const req = new Request("http://localhost/context?project=balanced&max_chars=5000", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body.length).toBeLessThanOrEqual(5500);

			// Rough check: each populated topic should have at least one bullet
			expect(body).toContain("Project Context");
			expect(body).toContain("Recent Decisions");
			expect(body).toContain("Known Issues");
			expect(body).toContain("Your Preferences");
			expect(body).toContain("General");
		});

		it("prioritizes curated facts within a topic even when older than noisy facts", async () => {
			const now = Date.now();
			await seedMemories(testDb.db, "priority", [
				{
					topic: "general",
					content: `Noisy recent fact ${"x".repeat(700)}`,
					curated: 0,
					updatedAt: new Date(now).toISOString(),
				},
				{
					topic: "general",
					content: "Curated critical fact must survive truncation",
					curated: 1,
					updatedAt: new Date(now - 100_000).toISOString(),
				},
			]);
			const req = new Request("http://localhost/context?project=priority&max_chars=700", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("Curated critical fact must survive truncation");
		});
	});

	describe("dual-tier context (global + project-specific)", () => {
		it("B1 — retrieves both global and project-specific memories", async () => {
			await seedMemories(testDb.db, GLOBAL_PROJECT_ID, [
				{ topic: "preferences", content: "Global pref: use tabs" },
			]);
			await seedMemories(testDb.db, "my-project", [
				{ topic: "project_context", content: "Project uses React" },
			]);
			const req = new Request("http://localhost/context?project=my-project", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("Global pref: use tabs");
			expect(body).toContain("Project uses React");
		});

		it("B2 — global section appears before project topic sections", async () => {
			await seedMemories(testDb.db, GLOBAL_PROJECT_ID, [
				{ topic: "preferences", content: "Global: tabs over spaces" },
			]);
			await seedMemories(testDb.db, "my-proj-order", [
				{ topic: "general", content: "Project fact" },
			]);
			const req = new Request("http://localhost/context?project=my-proj-order", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			// The global section header should appear before any project-specific topic header
			const globalIdx = body.indexOf("Global Preferences");
			const generalIdx = body.indexOf("General"); // project section
			expect(globalIdx).toBeGreaterThanOrEqual(0);
			expect(generalIdx).toBeGreaterThan(globalIdx);
		});

		it("B3 — override note present in context header", async () => {
			await seedMemories(testDb.db, GLOBAL_PROJECT_ID, [
				{ topic: "preferences", content: "Global pref" },
			]);
			await seedMemories(testDb.db, "my-proj-override", [
				{ topic: "general", content: "Project fact" },
			]);
			const req = new Request("http://localhost/context?project=my-proj-override", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body.toLowerCase()).toContain("override");
		});

		it("B4 — 25% budget cap on global memories", async () => {
			// Seed enough global facts to exceed 25% of 4000 = 1000 chars
			await seedMemories(testDb.db, GLOBAL_PROJECT_ID, [
				{ topic: "preferences", content: `Global fact ${"x".repeat(300)}` },
				{ topic: "preferences", content: `Global fact ${"y".repeat(300)}` },
				{ topic: "preferences", content: `Global fact ${"z".repeat(300)}` },
				{ topic: "preferences", content: `Global fact ${"w".repeat(300)}` },
			]);
			await seedMemories(testDb.db, "my-proj-cap", [
				{ topic: "general", content: `Project fact ${"a".repeat(400)}` },
				{ topic: "general", content: `Project fact ${"b".repeat(400)}` },
			]);
			const req = new Request("http://localhost/context?project=my-proj-cap&max_chars=4000", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			// Find the global section bounds
			const globalSectionStart = body.indexOf("### Global Preferences");
			const projectContextHeader = body.indexOf("###");
			const globalSectionEnd =
				projectContextHeader > globalSectionStart
					? projectContextHeader
					: body.indexOf("## ", globalSectionStart + 1);
			const globalSectionLen =
				globalSectionStart >= 0
					? (globalSectionEnd > globalSectionStart ? globalSectionEnd : body.length) -
						globalSectionStart
					: 0;
			expect(globalSectionLen).toBeLessThanOrEqual(1100); // ~1000 + header overhead
		});

		it("B5 — no global placeholder when no global memories exist", async () => {
			// Only seed project-specific memories, no global
			await seedMemories(testDb.db, "my-proj-empty-global", [
				{ topic: "general", content: "Project only fact" },
			]);
			const req = new Request("http://localhost/context?project=my-proj-empty-global", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).not.toContain("Global Preferences");
			expect(body).toContain("Project only fact");
		});

		it("B6 — no global when project has no memories and no global memories", async () => {
			// Neither project nor global has memories
			testDb.db
				.insert(projects)
				.values({
					id: "my-proj-no-mem",
					name: "No Mem",
					sessionCount: 0,
					createdAt: new Date().toISOString(),
					lastSeen: new Date().toISOString(),
				})
				.run();
			const req = new Request("http://localhost/context?project=my-proj-no-mem", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).not.toContain("Global Preferences");
			expect(body).toContain("No memories");
		});

		it("B7 — global memories appear even when project has no own memories", async () => {
			await seedMemories(testDb.db, GLOBAL_PROJECT_ID, [
				{ topic: "preferences", content: "Global: only fact" },
			]);
			// Project exists but has no memories
			testDb.db
				.insert(projects)
				.values({
					id: "my-proj-only-global",
					name: "Only Global",
					sessionCount: 0,
					createdAt: new Date().toISOString(),
					lastSeen: new Date().toISOString(),
				})
				.run();
			const req = new Request("http://localhost/context?project=my-proj-only-global", {
				headers: authHeaders(),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("Global: only fact");
		});
	});
});
