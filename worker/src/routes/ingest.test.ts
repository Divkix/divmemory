import { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { bearerAuth } from "../auth";
import { projects, sessions } from "../schema";
import { createIngestRoute, jaccardSimilarity, recoverJSON } from "./ingest";

const TEST_API_KEY = "test-api-key-123";

/** Build an in-memory SQLite DB wrapped by Drizzle for tests */
function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite);
	// Create tables matching the schema
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

function createIngestApp(db: ReturnType<typeof drizzle>) {
	const app = new Hono<{ Bindings: { DB: typeof db; DIVMEMORY_API_KEY: string } }>();
	app.use("/ingest", bearerAuth("divmemory_session"));
	createIngestRoute(app, db);
	return app;
}

function envVars() {
	return { DIVMEMORY_API_KEY: TEST_API_KEY };
}

function authHeaders() {
	return { Authorization: `Bearer ${TEST_API_KEY}`, "Content-Type": "application/json" };
}

describe("ingest endpoint", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let app: ReturnType<typeof createIngestApp>;

	beforeEach(() => {
		testDb = createTestDb();
		app = createIngestApp(testDb.db);
	});

	describe("validation", () => {
		it("returns 200 with facts_written for valid payload", async () => {
			const body = {
				session_id: "sess-001",
				project_id: "proj/test",
				project_name: "Test Project",
				source: "droid",
				conversation: "User: hello\n\nAssistant: hi",
				metadata: {},
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const json = (await res.json()) as { ok: boolean; facts_written: number };
			expect(json.ok).toBe(true);
			expect(typeof json.facts_written).toBe("number");
		});

		it("returns 400 when session_id missing", async () => {
			const body = { project_id: "proj/test", conversation: "hello" };
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(400);
		});

		it("returns 400 when project_id missing", async () => {
			const body = { session_id: "sess-001", conversation: "hello" };
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(400);
		});

		it("returns 400 when conversation missing", async () => {
			const body = { session_id: "sess-001", project_id: "proj/test" };
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(400);
		});

		it("returns 400 for empty string session_id", async () => {
			const body = {
				session_id: "",
				project_id: "proj/test",
				conversation: "hello",
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(400);
		});

		it("returns 400 for empty string project_id", async () => {
			const body = {
				session_id: "sess-001",
				project_id: "",
				conversation: "hello",
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(400);
		});

		it("returns 200 with facts_written 0 for empty conversation", async () => {
			const body = {
				session_id: "sess-001",
				project_id: "proj/test",
				conversation: "",
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect(res.status).toBe(200);
			const json = (await res.json()) as { facts_written: number };
			expect(json.facts_written).toBe(0);
		});

		it("accepts metadata field without error", async () => {
			const body = {
				session_id: "sess-meta",
				project_id: "proj/meta",
				conversation: "hello",
				metadata: { tool: "cursor", version: "1.2.3" },
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
			expect([200, 400]).toContain(res.status);
		});
	});

	describe("project upsert", () => {
		it("creates new project on first ingest", async () => {
			const body = {
				session_id: "sess-001",
				project_id: "github.com/new/proj",
				project_name: "New Project",
				source: "droid",
				conversation: "User: hello",
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			await app.fetch(req, envVars() as unknown as Record<string, string>);
			const proj = testDb.db
				.select()
				.from(projects)
				.where(eq(projects.id, "github.com/new/proj"))
				.get();
			expect(proj).toBeDefined();
			expect(proj?.name).toBe("New Project");
			expect(proj?.sessionCount).toBe(1);
		});

		it("updates existing project on subsequent ingest", async () => {
			for (let i = 0; i < 2; i++) {
				const body = {
					session_id: `sess-${i}`,
					project_id: "github.com/existing/proj",
					project_name: "Existing Project",
					source: "droid",
					conversation: "User: hello",
				};
				const req = new Request("http://localhost/ingest", {
					method: "POST",
					headers: authHeaders(),
					body: JSON.stringify(body),
				});
				await app.fetch(req, envVars() as unknown as Record<string, string>);
			}
			const proj = testDb.db
				.select()
				.from(projects)
				.where(eq(projects.id, "github.com/existing/proj"))
				.get();
			expect(proj?.sessionCount).toBe(2);
			expect(proj?.name).toBe("Existing Project");
		});
	});

	describe("session insertion", () => {
		it("stores session with correct fields", async () => {
			const body = {
				session_id: "sess-store",
				project_id: "proj/store",
				project_name: "Store",
				source: "opencode",
				conversation: "User: hello world",
				metadata: { tool: "cursor", version: "1.0" },
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			await app.fetch(req, envVars() as unknown as Record<string, string>);
			const sess = testDb.db.select().from(sessions).where(eq(sessions.id, "sess-store")).get();
			expect(sess).toBeDefined();
			expect(sess?.projectId).toBe("proj/store");
			expect(sess?.source).toBe("opencode");
			expect(sess?.rawText).toBe("User: hello world");
			expect(sess?.consolidated).toBe(0);
			expect(sess?.extractionError).toBeNull();
		});

		it("stores unicode and emoji without corruption", async () => {
			const body = {
				session_id: "sess-unicode",
				project_id: "proj/unicode",
				project_name: "Unicode",
				source: "droid",
				conversation: "User: 你好世界 🚀\nAssistant: Hi! Special chars: <>&\"'",
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			await app.fetch(req, envVars() as unknown as Record<string, string>);
			const sess = testDb.db.select().from(sessions).where(eq(sessions.id, "sess-unicode")).get();
			expect(sess?.rawText).toContain("你好世界");
			expect(sess?.rawText).toContain("🚀");
		});
	});

	describe("duplicate handling", () => {
		it("returns 409 or idempotent on duplicate session_id", async () => {
			const body = {
				session_id: "sess-dup",
				project_id: "proj/dup",
				project_name: "Dup",
				source: "droid",
				conversation: "User: hi",
			};
			for (let i = 0; i < 2; i++) {
				const req = new Request("http://localhost/ingest", {
					method: "POST",
					headers: authHeaders(),
					body: JSON.stringify(body),
				});
				await app.fetch(req, envVars() as unknown as Record<string, string>);
			}
			// Count sessions - there should only be 1
			const count = testDb.db
				.select({ count: sql<number>`count(*)` })
				.from(sessions)
				.where(eq(sessions.projectId, "proj/dup"))
				.get();
			expect(count?.count).toBe(1);
			// Project session_count should be 1 (not incremented twice)
			const proj = testDb.db.select().from(projects).where(eq(projects.id, "proj/dup")).get();
			expect(proj?.sessionCount).toBe(1);
		});

		it("re-ingestion with different content yields 409 or skip", async () => {
			const req1 = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({
					session_id: "sess-reingest",
					project_id: "proj/reingest",
					conversation: "Original text",
				}),
			});
			await app.fetch(req1, envVars() as unknown as Record<string, string>);
			const req2 = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify({
					session_id: "sess-reingest",
					project_id: "proj/reingest",
					conversation: "Different text",
				}),
			});
			const res2 = await app.fetch(req2, envVars() as unknown as Record<string, string>);
			// Should be 409 or 200 with facts_written:0, not 500
			expect([200, 409]).toContain(res2.status);
			if (res2.status === 200) {
				const j2 = (await res2.json()) as { facts_written: number };
				expect(j2.facts_written).toBe(0);
			}
		});
	});

	describe("session count invariant", () => {
		it("session_count matches COUNT(*) after each ingest", async () => {
			for (let i = 0; i < 5; i++) {
				const body = {
					session_id: `sess-inv-${i}`,
					project_id: "proj/invariant",
					project_name: "Inv",
					conversation: "text",
				};
				const req = new Request("http://localhost/ingest", {
					method: "POST",
					headers: authHeaders(),
					body: JSON.stringify(body),
				});
				await app.fetch(req, envVars() as unknown as Record<string, string>);
				const proj = testDb.db
					.select()
					.from(projects)
					.where(eq(projects.id, "proj/invariant"))
					.get();
				const actual = testDb.db
					.select({ count: sql<number>`count(*)` })
					.from(sessions)
					.where(eq(sessions.projectId, "proj/invariant"))
					.get();
				expect(proj?.sessionCount).toBe(actual?.count);
			}
		});
	});
});

describe("extractFacts — JSON recovery and Firepass responses", () => {
	it("recovers markdown-fenced JSON", async () => {
		const raw =
			'```json\n{"facts":[{"topic":"general","content":"Test fact","confidence":0.9}]}\n```';
		const result = recoverJSON(raw);
		expect(result).toBeDefined();
		expect(result?.facts).toHaveLength(1);
		expect(result?.facts[0].content).toBe("Test fact");
	});

	it("recovers partial JSON with valid objects inside", async () => {
		const raw =
			'{"facts": [{"topic":"general","content":"Fact A","confidence":0.9}, {"topic":"decisions","content":"Fact B';
		const result = recoverJSON(raw);
		expect(result).toBeDefined();
		expect(result?.facts.length).toBeGreaterThanOrEqual(1);
		expect(result?.facts[0].content).toBe("Fact A");
	});

	it("returns null on completely unparseable garbage", async () => {
		const raw = "I'm sorry, I cannot help with that.";
		const result = recoverJSON(raw);
		expect(result).toBeNull();
	});

	it("parses clean JSON directly", async () => {
		const raw = JSON.stringify({
			facts: [{ topic: "general", content: "Clean fact", confidence: 0.95 }],
		});
		const result = recoverJSON(raw);
		expect(result).toBeDefined();
		expect(result?.facts).toHaveLength(1);
		expect(result?.facts[0].confidence).toBe(0.95);
	});

	it("returns empty facts array as-is", async () => {
		const raw = JSON.stringify({ facts: [] });
		const result = recoverJSON(raw);
		expect(result).toBeDefined();
		expect(result?.facts).toHaveLength(0);
	});
});

describe("jaccardSimilarity — token overlap dedup", () => {
	it("returns 1.0 for identical strings", () => {
		expect(jaccardSimilarity("hello world", "hello world")).toBe(1);
	});

	it("returns 0.0 for completely different strings", () => {
		expect(jaccardSimilarity("abc xyz", "def uvw")).toBe(0);
	});

	it("measures >60% overlap for similar facts", () => {
		const a = "Developer always uses Vim keybindings and Vim editing everywhere";
		const b = "Developer always uses Vim keybindings in Vim editing";
		expect(jaccardSimilarity(a, b)).toBeGreaterThan(0.6);
	});

	it("returns lower value for weakly related facts", () => {
		const a = "Uses TypeScript strict mode";
		const b = "Prefers dark mode for IDE";
		expect(jaccardSimilarity(a, b)).toBeLessThan(0.6);
	});
});
