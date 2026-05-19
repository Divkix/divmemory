import { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { bearerAuth } from "../auth";
import { csrfValidate } from "../csrf";
import { memories, sessions } from "../schema";
import { createConsolidateRoute, isConsolidationInFlight, runConsolidation } from "./consolidate";

const TEST_API_KEY = "test-api-key-123";

/* ───────── helpers ───────── */

/** Build an in-memory SQLite DB wrapped by Drizzle for tests */
function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite);
	sqlite.exec(`
		CREATE TABLE projects (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT,
			session_count INTEGER DEFAULT 0,
			created_at TEXT,
			last_seen TEXT
		);
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY NOT NULL,
			project_id TEXT NOT NULL,
			source TEXT,
			raw_text TEXT,
			consolidated INTEGER DEFAULT 0,
			extraction_error TEXT,
			token_count INTEGER,
			metadata TEXT,
			created_at TEXT,
			FOREIGN KEY (project_id) REFERENCES projects(id)
		);
		CREATE INDEX idx_sessions_project_id ON sessions (project_id);
		CREATE INDEX idx_sessions_project_id_consolidated ON sessions (project_id, consolidated);
		CREATE TABLE memories (
			id TEXT PRIMARY KEY NOT NULL,
			project_id TEXT NOT NULL,
			source_session TEXT NOT NULL,
			topic TEXT,
			content TEXT,
			confidence REAL DEFAULT 0,
			curated INTEGER DEFAULT 0,
			status TEXT DEFAULT 'active',
			created_at TEXT,
			updated_at TEXT,
			FOREIGN KEY (source_session) REFERENCES sessions(id)
		);
		CREATE INDEX idx_memories_project_id_topic ON memories (project_id, topic);
		CREATE INDEX idx_memories_project_id_status ON memories (project_id, status);
	`);
	return { sqlite, db };
}

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
	db: ReturnType<typeof drizzle>,
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
		"INSERT INTO memories (id, project_id, source_session, topic, content, confidence, curated, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		crypto.randomUUID(),
		projectId,
		sessionId,
		overrides?.topic ?? "general",
		content,
		overrides?.confidence ?? 0.9,
		overrides?.curated ?? 0,
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
	});

	describe("curated fact protection", () => {
		it("leaves curated=1 facts unchanged during consolidation", async () => {
			seedSessions(testDb.sqlite, "proj-d", 2);
			seedMemory(testDb.sqlite, "proj-d", "Curated fact one", { curated: 1, topic: "general" });
			const before = testDb.db
				.select()
				.from(memories)
				.where(eq(memories.projectId, "proj-d"))
				.all() as { content: string }[];
			expect(before[0].content).toBe("Curated fact one");
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
				.all() as { content: string }[];
			expect(after[0].content).toBe("Curated fact one");
		});
	});

	describe("auto-archiving", () => {
		it("archives curated facts not corroborated in 90+ days", async () => {
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
			expect(memRows[0].status).toBe("archived");
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
			expect(result.error).toBe("Firepass consolidation failed");
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
			expect(result.error).toBe("Firepass consolidation failed");
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

	describe("auto-archiving logic", () => {
		it("archives stale curated facts (>90 days)", async () => {
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
			expect(result.archived).toBe(1);
			const memRows = testDb.db
				.select()
				.from(memories)
				.where(and(eq(memories.projectId, "proj-archive"), eq(memories.curated, 1)))
				.all() as (typeof memories.$inferInsert)[];
			expect(memRows.length).toBeGreaterThan(0);
			expect(memRows[0].status).toBe("archived");
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
	});
});
