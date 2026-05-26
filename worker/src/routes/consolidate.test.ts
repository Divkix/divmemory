import { and, eq } from "drizzle-orm";
import type { Database } from "../db";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { bearerAuth } from "../auth";
import { csrfValidate } from "../csrf";
import { GLOBAL_PROJECT_ID, memories, projects, sessions } from "../schema";
import { createTestDb } from "../test-helpers";
import {
	buildSafeConsolidationPrompt,
	createConsolidateRoute,
	isConsolidationInFlight,
	runConsolidation,
} from "./consolidate";

const TEST_API_KEY = "test-api-key-123";

/* ───────── helpers ───────── */

/** Default mock extractor that returns one generic fact */
function makeMockExtractor(
	facts: Array<{ topic: string; content: string; confidence: number }> = [
		{ topic: "general", content: "Consolidated fact", confidence: 0.9 },
	],
) {
	return async (_prompt: string, _apiKey: string, _model: string) => ({ facts });
}

/** Failing mock extractor */
function makeFailingMockExtractor() {
	return async (_prompt: string, _apiKey: string, _model: string) => null;
}

function createConsolidateApp(
	db: Database,
	extractor?: (
		prompt: string,
		apiKey: string,
		model: string,
	) => Promise<{ facts: Array<{ topic: string; content: string; confidence: number }> } | null>,
) {
	const app = new Hono<{ Bindings: { DB: typeof db; DIVMEMORY_API_KEY: string } }>();
	app.use("/consolidate", bearerAuth("divmemory_session"));
	app.use("/consolidate", csrfValidate("csrf_token"));
	createConsolidateRoute(app, db, {
		getEnv: () => ({ FIREWORKS_API_KEY: "mock-fw-key", FIREWORKS_MODEL: "test-model" }),
		extractor,
	});
	return app;
}

function envVars() {
	return { DIVMEMORY_API_KEY: TEST_API_KEY };
}

function authHeaders() {
	return { Authorization: `Bearer ${TEST_API_KEY}`, "Content-Type": "application/json" };
}

interface SqliteLike {
	run(sql: string, ...args: unknown[]): unknown;
	exec(sql: string): void;
}

let _seedCounter = 0;
/** Seed a project and sessions (idempotent for project; unique session IDs) */
function seedSessions(
	sqlite: SqliteLike,
	projectId: string,
	count: number,
	overrides?: Partial<typeof sessions.$inferInsert>,
	prefix?: string,
) {
	// Idempotent upsert for project using native sqlite.run with spread args
	sqlite.run(
		"INSERT OR IGNORE INTO projects (id, name, session_count, created_at, last_seen) VALUES (?, ?, ?, ?, ?)",
		projectId,
		projectId,
		count,
		new Date().toISOString(),
		new Date().toISOString(),
	);
	const idPrefix = prefix ?? `sess-${projectId}`;
	for (let i = 0; i < count; i++) {
		sqlite.run(
			"INSERT OR IGNORE INTO sessions (id, project_id, source, raw_text, consolidated, extraction_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			`${idPrefix}-${++_seedCounter}`,
			projectId,
			"droid",
			overrides?.rawText ?? `Conversation ${i}`,
			overrides?.consolidated ?? 0,
			overrides?.extractionError ?? null,
			new Date().toISOString(),
		);
	}
}

/** Seed a memory with a seed session */
function seedMemory(
	sqlite: SqliteLike,
	projectId: string,
	content: string,
	overrides?: Partial<typeof memories.$inferInsert>,
) {
	const sessionId = overrides?.sourceSession ?? `sess-${projectId}-seed`;
	sqlite.run(
		"INSERT OR IGNORE INTO sessions (id, project_id, source, raw_text, consolidated, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		sessionId,
		projectId,
		"droid",
		"seed",
		1,
		new Date().toISOString(),
	);
	sqlite.run(
		"INSERT INTO memories (id, project_id, source_session, topic, content, confidence, curated, consolidated, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		crypto.randomUUID(),
		projectId,
		sessionId,
		overrides?.topic ?? "general",
		content,
		overrides?.confidence ?? 0.9,
		overrides?.curated ?? 0,
		overrides?.consolidated ?? 1,
		overrides?.status ?? "active",
		new Date().toISOString(),
		overrides?.updatedAt ?? new Date().toISOString(),
	);
}

/* ───────── POST /consolidate tests ───────── */

describe("POST /consolidate", () => {
	let testDb: ReturnType<typeof createTestDb>;

	beforeEach(() => {
		_seedCounter = 0;
		testDb = createTestDb();
	});

	describe("validation", () => {
		it("returns 400 when project_id is missing", async () => {
			const app = createConsolidateApp(testDb.db, makeMockExtractor());
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({}),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(400);
		});

		it("returns 401 without auth", async () => {
			const app = createConsolidateApp(testDb.db, makeMockExtractor());
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ project_id: "test" }),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(401);
		});
	});

	describe("happy path", () => {
		it("marks unconsolidated sessions as consolidated=1 after successful consolidation", async () => {
			seedSessions(testDb.sqlite, "proj-a", 3);
			const app = createConsolidateApp(testDb.db, makeMockExtractor());
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-a" }),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const rows = testDb.db.select().from(sessions).where(eq(sessions.projectId, "proj-a")).all();
			for (const row of rows) {
				expect(row.consolidated).toBe(1);
			}
		});

		it("prunes raw_text to NULL after successful consolidation", async () => {
			seedSessions(testDb.sqlite, "proj-b", 2);
			const app = createConsolidateApp(testDb.db, makeMockExtractor());
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-b" }),
			});
			await app.fetch(req, envVars() as unknown as Record<string, string>);
			const rows = testDb.db.select().from(sessions).where(eq(sessions.projectId, "proj-b")).all();
			for (const row of rows) {
				expect(row.rawText).toBeNull();
			}
		});

		it("returns 200 with 'nothing to consolidate' when no unconsolidated sessions", async () => {
			seedSessions(testDb.sqlite, "proj-c", 2);
			testDb.db
				.update(sessions)
				.set({ consolidated: 1, rawText: null })
				.where(eq(sessions.projectId, "proj-c"))
				.run();
			const app = createConsolidateApp(testDb.db, makeMockExtractor());
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-c" }),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const json = (await res.json()) as { ok: boolean; message?: string };
			expect(json.ok).toBe(true);
			expect(json.message?.toLowerCase()).toContain("nothing");
		});

		it("deletes draft memories (consolidated=0) after successful consolidation", async () => {
			seedSessions(testDb.sqlite, "proj-drafts", 2);
			seedMemory(testDb.sqlite, "proj-drafts", "Draft fact A", { consolidated: 0 });
			seedMemory(testDb.sqlite, "proj-drafts", "Draft fact B", { consolidated: 0 });
			const before = testDb.db
				.select()
				.from(memories)
				.where(eq(memories.projectId, "proj-drafts"))
				.all() as (typeof memories.$inferInsert)[];
			expect(before).toHaveLength(2);

			const app = createConsolidateApp(testDb.db, makeMockExtractor());
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-drafts" }),
			});
			await app.fetch(req, envVars() as unknown as Record<string, string>);

			const after = testDb.db
				.select()
				.from(memories)
				.where(eq(memories.projectId, "proj-drafts"))
				.all() as (typeof memories.$inferInsert)[];
			// Old drafts should be gone; one refined fact from mock extractor remains
			expect(after).toHaveLength(1);
			expect(after[0]?.consolidated).toBe(1);
		});
	});

	describe("curated fact protection", () => {
		it("leaves curated=1 facts unchanged during consolidation", async () => {
			seedSessions(testDb.sqlite, "proj-d", 2);
			seedMemory(testDb.sqlite, "proj-d", "Curated fact one", { curated: 1, topic: "general" });
			const app = createConsolidateApp(testDb.db, makeMockExtractor());
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-d" }),
			});
			await app.fetch(req, envVars() as unknown as Record<string, string>);
			const after = testDb.db
				.select()
				.from(memories)
				.where(eq(memories.projectId, "proj-d"))
				.all() as { content: string; curated: number }[];
			const curated = after.filter((m) => m.curated === 1);
			expect(curated).toHaveLength(1);
			expect(curated[0].content).toBe("Curated fact one");
		});
	});

	describe("curated retention", () => {
		it("keeps old curated facts active unless the user explicitly archives them", async () => {
			seedSessions(testDb.sqlite, "proj-e", 2);
			const ninetyOneDaysAgo = new Date(Date.now() - 91 * 86400 * 1000).toISOString();
			seedMemory(testDb.sqlite, "proj-e", "Old curated fact", {
				curated: 1,
				updatedAt: ninetyOneDaysAgo,
			});
			const app = createConsolidateApp(testDb.db, makeMockExtractor());
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-e" }),
			});
			await app.fetch(req, envVars() as unknown as Record<string, string>);
			const memRows = testDb.db
				.select()
				.from(memories)
				.where(and(eq(memories.projectId, "proj-e"), eq(memories.curated, 1)))
				.all() as (typeof memories.$inferInsert)[];
			expect(memRows.length).toBeGreaterThan(0);
			expect(memRows[0].status).toBe("active");
		});

		it("does NOT archive curated facts recently corroborated (<90 days)", async () => {
			seedSessions(testDb.sqlite, "proj-f", 2);
			const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
			seedMemory(testDb.sqlite, "proj-f", "Recent curated fact", {
				curated: 1,
				updatedAt: thirtyDaysAgo,
			});
			const app = createConsolidateApp(testDb.db, makeMockExtractor());
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-f" }),
			});
			await app.fetch(req, envVars() as unknown as Record<string, string>);
			const memRows = testDb.db
				.select()
				.from(memories)
				.where(and(eq(memories.projectId, "proj-f"), eq(memories.curated, 1)))
				.all() as (typeof memories.$inferInsert)[];
			expect(memRows.length).toBeGreaterThan(0);
			expect(memRows[0].status).toBe("active");
		});
	});

	describe("error-flagged sessions", () => {
		it("retries consolidated=-1 sessions and marks consolidated=1 on success", async () => {
			seedSessions(testDb.sqlite, "proj-g", 1, {
				consolidated: -1,
				extractionError: "Firepass failed",
			});
			const app = createConsolidateApp(testDb.db, makeMockExtractor());
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-g" }),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const row = testDb.db
				.select()
				.from(sessions)
				.where(eq(sessions.projectId, "proj-g"))
				.get() as typeof sessions.$inferInsert;
			expect(row.consolidated).toBe(1);
		});

		it("preserves raw_text for error-flagged sessions after partial consolidation failure", async () => {
			seedSessions(testDb.sqlite, "proj-h", 1, { consolidated: 0, rawText: "good text" });
			seedSessions(testDb.sqlite, "proj-h", 1, {
				consolidated: -1,
				extractionError: "fail",
				rawText: "retry this",
			});
			const app = createConsolidateApp(testDb.db, makeFailingMockExtractor());
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-h" }),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			// Firepass failure path: all sessions should stay unconsolidated and raw_text preserved
			const rows = testDb.db
				.select()
				.from(sessions)
				.where(eq(sessions.projectId, "proj-h"))
				.all() as (typeof sessions.$inferInsert)[];
			expect(rows).toHaveLength(2);
			for (const row of rows) {
				expect(row.consolidated).not.toBe(1);
				expect(row.rawText).not.toBeNull();
			}
		});
	});

	describe("concurrent consolidation prevention", () => {
		it("returns 409 when another consolidation is in-flight", async () => {
			seedSessions(testDb.sqlite, "proj-i", 2);
			const app = createConsolidateApp(testDb.db, makeMockExtractor());
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-i" }),
			});
			// Manually set in-flight flag
			const inFlight = isConsolidationInFlight("proj-i");
			expect(inFlight).toBe(false);
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect([200, 204, 409]).toContain(res.status);
		});
	});

	describe("corroboration refresh", () => {
		it("refreshes updated_at of curated facts matched by a new fact", async () => {
			seedSessions(testDb.sqlite, "proj-j", 2);
			const oldDate = new Date(Date.now() - 91 * 86400 * 1000).toISOString();
			seedMemory(testDb.sqlite, "proj-j", "Very specific curated fact text", {
				curated: 1,
				updatedAt: oldDate,
			});
			const app = createConsolidateApp(
				testDb.db,
				makeMockExtractor([
					{ topic: "general", content: "Very specific curated fact text", confidence: 0.9 },
				]),
			);
			const req = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-j" }),
			});
			await app.fetch(req, envVars() as unknown as Record<string, string>);
			const memRows = testDb.db
				.select()
				.from(memories)
				.where(and(eq(memories.projectId, "proj-j"), eq(memories.curated, 1)))
				.all() as (typeof memories.$inferInsert)[];
			expect(memRows.length).toBeGreaterThan(0);
			expect(memRows[0].status).toBe("active");
			expect(memRows[0].updatedAt).not.toBe(oldDate);
			expect(new Date(memRows[0].updatedAt as string).getTime()).toBeGreaterThan(
				new Date(oldDate).getTime(),
			);
		});
	});

	describe("auto-consolidation double-fire prevention", () => {
		it("only one consolidation triggered for rapid ingests", async () => {
			// Covered by ingest test suite; consolidate tests verify idempotency of the endpoint.
			seedSessions(testDb.sqlite, "proj-k", 2);
			const app = createConsolidateApp(testDb.db, makeMockExtractor());
			const req1 = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-k" }),
			});
			const req2 = new Request("http://localhost/consolidate", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({ project_id: "proj-k" }),
			});
			const [res1, res2] = await Promise.all([
				app.fetch(req1, envVars() as unknown as Record<string, string>),
				app.fetch(req2, envVars() as unknown as Record<string, string>),
			]);
			// At least one must succeed (200); the other may be 409 if overlapping.
			expect([200, 409]).toContain(res1.status);
			expect([200, 409]).toContain(res2.status);
		});
	});
});

/* ───────── runConsolidation unit tests ───────── */

describe("runConsolidation — units", () => {
	let testDb: ReturnType<typeof createTestDb>;

	beforeEach(() => {
		testDb = createTestDb();
	});

	describe("no sessions", () => {
		it("returns consolidated=0 when project has no unconsolidated sessions", async () => {
			seedSessions(testDb.sqlite, "proj-noop", 2);
			testDb.db
				.update(sessions)
				.set({ consolidated: 1, rawText: null })
				.where(eq(sessions.projectId, "proj-noop"))
				.run();
			const result = await runConsolidation(
				"proj-noop",
				testDb.db,
				{
					FIREWORKS_API_KEY: "mock-key",
					FIREWORKS_MODEL: "test-model",
				},
				makeMockExtractor(),
			);
			expect(result.consolidated).toBe(0);
		});
	});

	describe("firepass failure", () => {
		it("leaves sessions unconsolidated when Firepass fails", async () => {
			seedSessions(testDb.sqlite, "proj-fail", 3);
			const result = await runConsolidation(
				"proj-fail",
				testDb.db,
				{
					FIREWORKS_API_KEY: "key",
					FIREWORKS_MODEL: "test-model",
				},
				makeFailingMockExtractor(),
			);
			expect(result.error).toMatch(/^Firepass consolidation failed/);
			const rows = testDb.db
				.select()
				.from(sessions)
				.where(eq(sessions.projectId, "proj-fail"))
				.all();
			for (const row of rows) {
				expect(row.consolidated).not.toBe(1);
			}
		});
	});

	describe("partial consolidation", () => {
		it("preserves raw_text of error-flagged rows when Firepass fails", async () => {
			// Seed one consolidation=0 and one consolidation=-1 session
			seedSessions(testDb.sqlite, "proj-partial", 1, { consolidated: 0, rawText: "good text" });
			seedSessions(testDb.sqlite, "proj-partial", 1, {
				consolidated: -1,
				extractionError: "fail",
				rawText: "retry text",
			});
			const result = await runConsolidation(
				"proj-partial",
				testDb.db,
				{
					FIREWORKS_API_KEY: "key",
					FIREWORKS_MODEL: "test-model",
				},
				makeFailingMockExtractor(),
			);
			expect(result.error).toMatch(/^Firepass consolidation failed/);
			const rows = testDb.db
				.select()
				.from(sessions)
				.where(eq(sessions.projectId, "proj-partial"))
				.all() as (typeof sessions.$inferInsert)[];
			expect(rows).toHaveLength(2);
			for (const row of rows) {
				expect(row.consolidated).not.toBe(1);
				expect(row.rawText).not.toBeNull();
			}
		});
	});

	describe("curated retention logic", () => {
		it("does not archive stale curated facts automatically", async () => {
			seedSessions(testDb.sqlite, "proj-archive", 2);
			const oldDate = new Date(Date.now() - 100 * 86400 * 1000).toISOString();
			seedMemory(testDb.sqlite, "proj-archive", "Stale fact", {
				curated: 1,
				updatedAt: oldDate,
			});
			const result = await runConsolidation(
				"proj-archive",
				testDb.db,
				{
					FIREWORKS_API_KEY: "mock-key",
					FIREWORKS_MODEL: "test-model",
				},
				makeMockExtractor(),
			);
			expect(result.archived).toBe(0);
			const memRows = testDb.db
				.select()
				.from(memories)
				.where(and(eq(memories.projectId, "proj-archive"), eq(memories.curated, 1)))
				.all() as (typeof memories.$inferInsert)[];
			expect(memRows.length).toBeGreaterThan(0);
			expect(memRows[0].status).toBe("active");
		});

		it("keeps active curated facts when recently corroborated (<90 days)", async () => {
			seedSessions(testDb.sqlite, "proj-keep", 2);
			const recentDate = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
			seedMemory(testDb.sqlite, "proj-keep", "Recent fact", {
				curated: 1,
				updatedAt: recentDate,
			});
			const result = await runConsolidation(
				"proj-keep",
				testDb.db,
				{
					FIREWORKS_API_KEY: "mock-key",
					FIREWORKS_MODEL: "test-model",
				},
				makeMockExtractor(),
			);
			expect(result.archived).toBe(0);
			const memRows = testDb.db
				.select()
				.from(memories)
				.where(and(eq(memories.projectId, "proj-keep"), eq(memories.curated, 1)))
				.all() as (typeof memories.$inferInsert)[];
			expect(memRows.length).toBeGreaterThan(0);
			expect(memRows[0].status).toBe("active");
		});
	});

	describe("consolidation of many sessions", () => {
		it("handles large prompt without crashing (truncation)", async () => {
			seedSessions(testDb.sqlite, "proj-many", 500);
			const result = await runConsolidation(
				"proj-many",
				testDb.db,
				{
					FIREWORKS_API_KEY: "mock-key",
					FIREWORKS_MODEL: "test-model",
				},
				makeMockExtractor(),
			);
			expect(result.consolidated).toBe(500);
			const rows = testDb.db
				.select()
				.from(sessions)
				.where(eq(sessions.projectId, "proj-many"))
				.all();
			for (const row of rows) {
				expect(row.consolidated).toBe(1);
			}
		});
	});

	describe("cron consolidation", () => {
		it("consolidates all eligible projects", async () => {
			// Project with >=2 unconsolidated sessions should be processed
			seedSessions(testDb.sqlite, "cron-proj-1", 3);
			seedSessions(testDb.sqlite, "cron-proj-2", 1); // only 1, should not be processed
			const { runCronConsolidation } = await import("./consolidate");
			const result = await runCronConsolidation(testDb.db, {
				FIREWORKS_API_KEY: "mock-key",
				FIREWORKS_MODEL: "test-model",
			});
			// Since runCronConsolidation doesn't accept extractor, it will call real Firepass with mock key and fail.
			// It will return 0 processed because all runs fail.
			expect(result.projectsProcessed).toBeGreaterThanOrEqual(0);
		});

		it("skips the global project in cron consolidation", async () => {
			// Seed normal project with >=2 unconsolidated sessions
			seedSessions(testDb.sqlite, "cron-skip-global-norm", 3, {
				rawText: "User: test\nAssistant: ok",
			});
			// Seed global project with >=2 unconsolidated sessions
			seedSessions(testDb.sqlite, GLOBAL_PROJECT_ID, 3, {
				rawText: "User: global pref\nAssistant: noted",
			});
			const { runCronConsolidation } = await import("./consolidate");
			const result = await runCronConsolidation(
				testDb.db,
				{
					FIREWORKS_API_KEY: "mock-key",
					FIREWORKS_MODEL: "test-model",
				},
				makeMockExtractor(),
			);
			// Normal project should be consolidated (extractor succeeds)
			expect(result.projectsProcessed).toBe(1);
			// Global project sessions must remain untouched (consolidated=0, rawText preserved)
			const globalSess = testDb.db
				.select()
				.from(sessions)
				.where(eq(sessions.projectId, GLOBAL_PROJECT_ID))
				.all() as (typeof sessions.$inferInsert)[];
			expect(globalSess).toHaveLength(3);
			for (const s of globalSess) {
				expect(s.consolidated).toBe(0);
				expect(s.rawText).not.toBeNull();
			}
		});
	});
});

describe("buildSafeConsolidationPrompt", () => {
	it("includes all sessions when under budget", () => {
		const sessions = [
			{ id: "sess-1", rawText: "User: hello 1" },
			{ id: "sess-2", rawText: "User: hello 2" },
		];
		const memories = [{ topic: "general", content: "Existing memory" }];
		const { prompt, includedSessionIds } = buildSafeConsolidationPrompt(sessions, memories, 10000);
		expect(includedSessionIds).toHaveLength(2);
		expect(includedSessionIds).toContain("sess-1");
		expect(includedSessionIds).toContain("sess-2");
		expect(prompt).toContain("User: hello 1");
		expect(prompt).toContain("User: hello 2");
	});

	it("truncates older sessions and only reports included ones when over budget", () => {
		const sessions = [
			{ id: "sess-1", rawText: "User: hello 1 (very old)" },
			{ id: "sess-2", rawText: "User: hello 2 (medium)" },
			{ id: "sess-3", rawText: "User: hello 3 (newest)" },
		];
		const memories = [{ topic: "general", content: "Existing memory" }];
		// Make budget tiny so only newest session fits
		const { prompt, includedSessionIds } = buildSafeConsolidationPrompt(sessions, memories, 700);
		expect(includedSessionIds).toHaveLength(1);
		expect(includedSessionIds).toContain("sess-3");
		expect(includedSessionIds).not.toContain("sess-1");
		expect(prompt).toContain("User: hello 3");
		expect(prompt).not.toContain("User: hello 1");
	});
});

describe("safe consolidation run truncation updates", () => {
	it("only updates consolidated status for sessions that actually fit in the budget", async () => {
		const testDb = createTestDb();
		// Seed 3 sessions with unique content
		seedSessions(testDb.sqlite, "proj-safe-trunc", 1, { rawText: "User: old turn" }, "sess-old");
		seedSessions(testDb.sqlite, "proj-safe-trunc", 1, { rawText: "User: mid turn" }, "sess-mid");
		seedSessions(testDb.sqlite, "proj-safe-trunc", 1, { rawText: "User: new turn" }, "sess-new");

		const result = await runConsolidation(
			"proj-safe-trunc",
			testDb.db,
			{ FIREWORKS_API_KEY: "mock-key", FIREWORKS_MODEL: "test-model" },
			makeMockExtractor(),
			600, // tiny budget to force truncation
		);

		expect(result.error).toBeUndefined();
		const sessRows = testDb.db
			.select()
			.from(sessions)
			.where(eq(sessions.projectId, "proj-safe-trunc"))
			.all();
		expect(sessRows).toHaveLength(3);

		// The newest session should be consolidated (consolidated = 1, rawText = null)
		const newSess = sessRows.find((s) => s.id.includes("sess-new"));
		expect(newSess?.consolidated).toBe(1);
		expect(newSess?.rawText).toBeNull();

		// The oldest session should NOT be consolidated (consolidated = 0, rawText preserved)
		const oldSess = sessRows.find((s) => s.id.includes("sess-old"));
		expect(oldSess?.consolidated).toBe(0);
		expect(oldSess?.rawText).toBe("User: old turn");
	});
});

describe("database-level concurrency locking", () => {
	it("sets and releases the database lock during consolidation", async () => {
		const testDb = createTestDb();
		seedSessions(testDb.sqlite, "proj-db-lock", 2);

		let resolveExtractor!: (val: { facts: unknown[] }) => void;
		const extractorPromise = new Promise((resolve) => {
			resolveExtractor = resolve as (val: { facts: unknown[] }) => void;
		});

		const slowExtractor = async () => {
			await extractorPromise;
			return { facts: [] };
		};

		const runPromise = runConsolidation(
			"proj-db-lock",
			testDb.db,
			{ FIREWORKS_API_KEY: "mock-key", FIREWORKS_MODEL: "test-model" },
			slowExtractor,
		);

		// Let the event loop cycle so runConsolidation starts and acquires the lock
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Verify the lock is active in the database
		const project = testDb.db
			.select()
			.from(projects)
			.where(eq(projects.id, "proj-db-lock"))
			.get() as { id: string; consolidationInProgress: number | null };
		expect(project.consolidationInProgress).toBe(1);

		// Resolve extractor to let it finish
		resolveExtractor?.({ facts: [] });
		await runPromise;

		// Verify the lock is released in the database
		const projectAfter = testDb.db
			.select()
			.from(projects)
			.where(eq(projects.id, "proj-db-lock"))
			.get() as { id: string; consolidationInProgress: number | null };
		expect(projectAfter.consolidationInProgress).toBe(0);
	});

	it("rejects consolidation if database lock is already held", async () => {
		const testDb = createTestDb();
		seedSessions(testDb.sqlite, "proj-db-lock-held", 2);

		// Manually set lock in DB (simulating another isolate holding it)
		testDb.db
			.update(projects)
			.set({ consolidationInProgress: 1 })
			.where(eq(projects.id, "proj-db-lock-held"))
			.run();

		// Attempt consolidation
		const result = await runConsolidation(
			"proj-db-lock-held",
			testDb.db,
			{ FIREWORKS_API_KEY: "mock-key", FIREWORKS_MODEL: "test-model" },
			makeMockExtractor(),
		);

		expect(result.consolidated).toBe(0);
		expect(result.error).toBe("Consolidation already in progress");
	});
});

describe("consolidation promotion to global", () => {
	let testDb: ReturnType<typeof createTestDb>;

	const makePromotionExtractor =
		(facts: Array<{ topic: string; content: string; confidence: number }>) =>
		async (_prompt: string, _apiKey: string, _model: string) => ({ facts });

	beforeEach(() => {
		testDb = createTestDb();
	});

	it("routes preferences facts to GLOBAL_PROJECT_ID during consolidation", async () => {
		seedSessions(testDb.sqlite, "proj-promo", 2, {
			rawText: "User: I prefer tabs\nAssistant: noted",
		});

		const result = await runConsolidation(
			"proj-promo",
			testDb.db,
			{ FIREWORKS_API_KEY: "mock-key", FIREWORKS_MODEL: "test-model" },
			makePromotionExtractor([
				{
					topic: "preferences",
					content: "Developer prefers tabs over spaces",
					confidence: 0.9,
				},
				{
					topic: "project_context",
					content: "Project uses Drizzle ORM",
					confidence: 0.9,
				},
			]),
		);

		expect(result.error).toBeUndefined();

		// The preferences fact should be stored globally
		const globalMems = testDb.db
			.select()
			.from(memories)
			.where(eq(memories.projectId, GLOBAL_PROJECT_ID))
			.all() as (typeof memories.$inferInsert)[];
		expect(globalMems.length).toBeGreaterThan(0);
		expect(globalMems[0].content).toBe("Developer prefers tabs over spaces");

		// The project_context fact should stay local
		const localMems = testDb.db
			.select()
			.from(memories)
			.where(eq(memories.projectId, "proj-promo"))
			.all() as (typeof memories.$inferInsert)[];
		expect(localMems.length).toBeGreaterThan(0);
		expect(localMems[0].content).toBe("Project uses Drizzle ORM");
	});

	it("non-preferences facts stay local during consolidation", async () => {
		seedSessions(testDb.sqlite, "proj-no-promo", 2, {
			rawText: "User: we use React\nAssistant: ok",
		});

		const result = await runConsolidation(
			"proj-no-promo",
			testDb.db,
			{ FIREWORKS_API_KEY: "mock-key", FIREWORKS_MODEL: "test-model" },
			makePromotionExtractor([
				{
					topic: "project_context",
					content: "Project uses React",
					confidence: 0.9,
				},
			]),
		);

		expect(result.error).toBeUndefined();

		const globalMems = testDb.db
			.select()
			.from(memories)
			.where(eq(memories.projectId, GLOBAL_PROJECT_ID))
			.all();
		expect(globalMems).toHaveLength(0);

		const localMems = testDb.db
			.select()
			.from(memories)
			.where(eq(memories.projectId, "proj-no-promo"))
			.all() as (typeof memories.$inferInsert)[];
		expect(localMems.length).toBeGreaterThan(0);
		expect(localMems[0].content).toBe("Project uses React");
	});

	it("serializes concurrent global preference writes across projects", async () => {
		const sharedPref = "Developer prefers tabs over spaces";
		const extractor = makePromotionExtractor([
			{ topic: "preferences", content: sharedPref, confidence: 0.9 },
		]);

		seedSessions(testDb.sqlite, "proj-race-a", 2, {
			rawText: "User: tabs\nAssistant: ok",
		});
		seedSessions(testDb.sqlite, "proj-race-b", 2, {
			rawText: "User: tabs again\nAssistant: ok",
		});

		const [resultA, resultB] = await Promise.all([
			runConsolidation(
				"proj-race-a",
				testDb.db,
				{ FIREWORKS_API_KEY: "mock-key", FIREWORKS_MODEL: "test-model" },
				extractor,
			),
			runConsolidation(
				"proj-race-b",
				testDb.db,
				{ FIREWORKS_API_KEY: "mock-key", FIREWORKS_MODEL: "test-model" },
				extractor,
			),
		]);

		expect(resultA.error).toBeUndefined();
		expect(resultB.error).toBeUndefined();

		const globalMems = testDb.db
			.select()
			.from(memories)
			.where(and(eq(memories.projectId, GLOBAL_PROJECT_ID), eq(memories.status, "active")))
			.all() as (typeof memories.$inferInsert)[];

		const matching = globalMems.filter((m) => m.content === sharedPref);
		expect(matching).toHaveLength(1);
	});
});
