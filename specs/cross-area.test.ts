import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sendIngest } from "../cli/src/cli";
import { bearerAuth } from "../worker/src/auth";
import { createConsolidateRoute } from "../worker/src/routes/consolidate";
import { createContextRoute } from "../worker/src/routes/context";
import { createIngestRoute } from "../worker/src/routes/ingest";
import { memories, projects, sessions } from "../worker/src/schema";

const TEST_API_KEY = "test-api-key-123";
const WORKER_URL = "http://localhost";

/** Build an in-memory SQLite DB matching the worker schema */
function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite);
	sqlite.exec(`
		CREATE TABLE projects (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT,
			session_count INTEGER DEFAULT 0,
			created_at TEXT,
			last_seen TEXT,
			consolidation_in_progress INTEGER DEFAULT 0
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
			consolidated INTEGER DEFAULT 0,
			status TEXT DEFAULT 'active',
			created_at TEXT,
			updated_at TEXT,
			FOREIGN KEY (source_session) REFERENCES sessions(id)
		);
		CREATE INDEX idx_memories_project_id_topic ON memories (project_id, topic);
		CREATE INDEX idx_memories_project_id_status ON memories (project_id, status);
		CREATE INDEX idx_memories_project_id_consolidated_curated ON memories (project_id, consolidated, curated);
	`);
	return { sqlite, db };
}

/** Create a full in-memory Hono app wired with ingest, context, and consolidate routes */
function createFullWorkerApp(db: ReturnType<typeof drizzle>) {
	const app = new Hono<{ Bindings: { DB: typeof db; DIVMEMORY_API_KEY: string } }>();
	app.use("/ingest", bearerAuth("divmemory_session"));
	app.use("/context", bearerAuth("divmemory_session"));
	app.use("/consolidate", bearerAuth("divmemory_session"));
	createIngestRoute(app, db, {
		getEnv: () => ({ FIREWORKS_API_KEY: TEST_API_KEY, FIREWORKS_MODEL: "test-model" }),
	});
	createContextRoute(app, db);
	createConsolidateRoute(app, db, {
		getEnv: () => ({ FIREWORKS_API_KEY: TEST_API_KEY, FIREWORKS_MODEL: "test-model" }),
		extractor: async () => ({
			facts: [{ topic: "general", content: "Consolidated fact for divmemory", confidence: 0.9 }],
		}),
	});
	return app;
}

/** Adapter to use Hono app.fetch as a standard fetch(url, init) function */
function appFetchAdapter(
	app: ReturnType<typeof createFullWorkerApp>,
	env = { DIVMEMORY_API_KEY: TEST_API_KEY },
) {
	return async (url: string, init: RequestInit) => {
		const req = new Request(url, init);
		return app.fetch(req, env as unknown as Record<string, string>);
	};
}

function authHeaders() {
	return { Authorization: `Bearer ${TEST_API_KEY}`, "Content-Type": "application/json" };
}

let _origFetch: typeof globalThis.fetch;

/** Mock global fetch so Fireworks calls return synthetic facts */
function mockGlobalFetch() {
	_origFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const u = String(url);
		if (u.includes("fireworks.ai")) {
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify({
									facts: [
										{
											topic: "general",
											content: "divmemory is a persistent memory system",
											confidence: 0.95,
										},
									],
								}),
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return _origFetch(url, init);
	};
}

function restoreGlobalFetch() {
	globalThis.fetch = _origFetch;
}

/** Seed a memory directly into the in-memory DB */
function seedMemory(
	db: ReturnType<typeof drizzle>,
	projectId: string,
	content: string,
	topic = "general",
) {
	const sessionId = crypto.randomUUID();
	db.insert(sessions)
		.values({
			id: sessionId,
			projectId,
			source: "droid",
			rawText: "seed",
			consolidated: 0,
			createdAt: new Date().toISOString(),
		})
		.run();
	db.insert(memories)
		.values({
			id: crypto.randomUUID(),
			projectId,
			sourceSession: sessionId,
			topic,
			content,
			confidence: 0.9,
			curated: 0,
			consolidated: 0,
			status: "active",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.run();
}

describe("Cross-Area — Full Pipeline", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let app: ReturnType<typeof createFullWorkerApp>;
	let fetchAdapter: ReturnType<typeof appFetchAdapter>;

	beforeEach(() => {
		testDb = createTestDb();
		app = createFullWorkerApp(testDb.db);
		fetchAdapter = appFetchAdapter(app);
		mockGlobalFetch();
	});

	afterEach(() => {
		restoreGlobalFetch();
	});

	it("VAL-CROSS-001: CLI sendIngest → Worker POST /ingest → Worker GET /context returns expected format", async () => {
		const result = await sendIngest(
			{
				sessionId: "sess-001",
				projectId: "github.com/divkix/test",
				projectName: "test",
				conversation: "User: hello\n\nAssistant: hi",
			},
			{ workerUrl: WORKER_URL, apiKey: TEST_API_KEY, fetch: fetchAdapter },
		);
		expect(result.ok).toBe(true);

		const req = new Request(`${WORKER_URL}/context?project=github.com/divkix/test`, {
			headers: authHeaders(),
		});
		const res = await app.fetch(req, { DIVMEMORY_API_KEY: TEST_API_KEY } as unknown as Record<
			string,
			string
		>);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("divmemory");
	});

	it("VAL-CROSS-002: session-end hook POST generates facts that session-start GET retrieves", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "cross-002-"));
		const transcriptPath = join(tmpDir, "transcript.jsonl");
		writeFileSync(
			transcriptPath,
			`${JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] })}\n`,
			"utf-8",
		);

		const oldApiKey = process.env.DIVMEMORY_API_KEY;
		const oldWorkerUrl = process.env.DIVMEMORY_WORKER_URL;
		process.env.DIVMEMORY_API_KEY = TEST_API_KEY;
		process.env.DIVMEMORY_WORKER_URL = WORKER_URL;

		const { processSessionEnd } = await import("../plugin/scripts/session-end.mjs");
		const { processSessionStart } = await import("../plugin/scripts/session-start.mjs");

		const capturedStderr: string[] = [];
		const capturedStdout: string[] = [];

		await processSessionEnd(
			JSON.stringify({
				session_id: "sess-end-002",
				cwd: tmpDir,
				transcript_path: transcriptPath,
				hook_event_name: "SessionEnd",
			}),
			{
				fetch: fetchAdapter,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			},
		);

		// Wait a tick so any microtasks/flushes finish
		await new Promise((r) => setTimeout(r, 10));

		await processSessionStart(
			JSON.stringify({
				session_id: "sess-start-002",
				cwd: tmpDir,
				hook_event_name: "SessionStart",
			}),
			{
				fetch: fetchAdapter,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			},
		);

		const stdoutText = capturedStdout.join("");
		expect(stdoutText).toContain("divmemory is a persistent memory system");

		process.env.DIVMEMORY_API_KEY = oldApiKey ?? undefined;
		process.env.DIVMEMORY_WORKER_URL = oldWorkerUrl ?? undefined;

		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("VAL-CROSS-003: consolidation triggered via API reflects in context", async () => {
		const body = {
			session_id: "sess-003",
			project_id: "github.com/divkix/consolidate-test",
			project_name: "Consolidate Test",
			source: "droid",
			conversation: "User: discuss memory\n\nAssistant: done",
		};
		const reqIngest = new Request(`${WORKER_URL}/ingest`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify(body),
		});
		const ingestRes = await app.fetch(reqIngest, {
			DIVMEMORY_API_KEY: TEST_API_KEY,
		} as unknown as Record<string, string>);
		expect(ingestRes.status).toBe(200);

		const reqConsolidate = new Request(`${WORKER_URL}/consolidate`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ project_id: "github.com/divkix/consolidate-test" }),
		});
		const consRes = await app.fetch(reqConsolidate, {
			DIVMEMORY_API_KEY: TEST_API_KEY,
		} as unknown as Record<string, string>);
		expect(consRes.status).toBe(200);

		const reqContext = new Request(
			`${WORKER_URL}/context?project=github.com/divkix/consolidate-test`,
			{ headers: authHeaders() },
		);
		const ctxRes = await app.fetch(reqContext, {
			DIVMEMORY_API_KEY: TEST_API_KEY,
		} as unknown as Record<string, string>);
		expect(ctxRes.status).toBe(200);
		const ctxText = await ctxRes.text();
		expect(ctxText).toContain("Consolidated fact for divmemory");
	});
});

describe("Cross-Area — Multi-Project Isolation", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let app: ReturnType<typeof createFullWorkerApp>;
	let fetchAdapter: ReturnType<typeof appFetchAdapter>;

	beforeEach(() => {
		testDb = createTestDb();
		app = createFullWorkerApp(testDb.db);
		fetchAdapter = appFetchAdapter(app);
		mockGlobalFetch();
	});

	afterEach(() => {
		restoreGlobalFetch();
	});

	it("VAL-CROSS-004: Bootstrapping two projects keeps facts isolated", async () => {
		await sendIngest(
			{ sessionId: "sess-a", projectId: "proj-a", projectName: "A", conversation: "A" },
			{ workerUrl: WORKER_URL, apiKey: TEST_API_KEY, fetch: fetchAdapter },
		);
		await sendIngest(
			{ sessionId: "sess-b", projectId: "proj-b", projectName: "B", conversation: "B" },
			{ workerUrl: WORKER_URL, apiKey: TEST_API_KEY, fetch: fetchAdapter },
		);

		seedMemory(testDb.db, "proj-b", "Beta-specific fact");

		const req = new Request(`${WORKER_URL}/context?project=proj-a`, { headers: authHeaders() });
		const res = await app.fetch(req, { DIVMEMORY_API_KEY: TEST_API_KEY } as unknown as Record<
			string,
			string
		>);
		const text = await res.text();
		expect(text).not.toContain("Beta-specific");
	});

	it("VAL-CROSS-005: Context for project A never includes project B memories", async () => {
		await sendIngest(
			{ sessionId: "sess-a-5", projectId: "proj-a-5", projectName: "A", conversation: "A" },
			{ workerUrl: WORKER_URL, apiKey: TEST_API_KEY, fetch: fetchAdapter },
		);
		await sendIngest(
			{ sessionId: "sess-b-5", projectId: "proj-b-5", projectName: "B", conversation: "B" },
			{ workerUrl: WORKER_URL, apiKey: TEST_API_KEY, fetch: fetchAdapter },
		);

		seedMemory(testDb.db, "proj-b-5", "Project B secret memory");

		const bRows = testDb.db.select().from(memories).where(eq(memories.projectId, "proj-b-5")).all();
		expect(bRows.length).toBeGreaterThan(0);

		const req = new Request(`${WORKER_URL}/context?project=proj-a-5`, { headers: authHeaders() });
		const res = await app.fetch(req, { DIVMEMORY_API_KEY: TEST_API_KEY } as unknown as Record<
			string,
			string
		>);
		const text = await res.text();
		expect(text).not.toContain("Project B secret memory");
	});
});

describe("Cross-Area — Bootstrap + Live Coexistence", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let app: ReturnType<typeof createFullWorkerApp>;
	let fetchAdapter: ReturnType<typeof appFetchAdapter>;

	beforeEach(() => {
		testDb = createTestDb();
		app = createFullWorkerApp(testDb.db);
		fetchAdapter = appFetchAdapter(app);
		mockGlobalFetch();
	});

	afterEach(() => {
		restoreGlobalFetch();
	});

	it("VAL-CROSS-006: Bootstrap session and live session for same project don't conflict", async () => {
		const projectId = "proj-same-6";
		await sendIngest(
			{ sessionId: "bootstrap-6", projectId, projectName: "Same", conversation: "hello" },
			{ workerUrl: WORKER_URL, apiKey: TEST_API_KEY, fetch: fetchAdapter },
		);

		const tmpDir = mkdtempSync(join(tmpdir(), "cross-006-"));
		const innerDir = join(tmpDir, projectId);
		mkdirSync(innerDir);
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["-C", innerDir, "init"]);
		execFileSync("git", ["-C", innerDir, "remote", "add", "origin", `https://${projectId}.git`]);
		const transcriptPath = join(innerDir, "transcript.jsonl");
		writeFileSync(
			transcriptPath,
			`${JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] })}\n`,
			"utf-8",
		);

		const oldApiKey = process.env.DIVMEMORY_API_KEY;
		const oldWorkerUrl = process.env.DIVMEMORY_WORKER_URL;
		process.env.DIVMEMORY_API_KEY = TEST_API_KEY;
		process.env.DIVMEMORY_WORKER_URL = WORKER_URL;

		const { processSessionEnd } = await import("../plugin/scripts/session-end.mjs");
		await processSessionEnd(
			JSON.stringify({
				session_id: "live-6",
				cwd: innerDir,
				transcript_path: transcriptPath,
				hook_event_name: "SessionEnd",
			}),
			{ fetch: fetchAdapter, stderr: () => {}, stdout: () => {} },
		);

		process.env.DIVMEMORY_API_KEY = oldApiKey ?? undefined;
		process.env.DIVMEMORY_WORKER_URL = oldWorkerUrl ?? undefined;

		const sessRows = testDb.db
			.select()
			.from(sessions)
			.where(eq(sessions.projectId, projectId))
			.all();
		expect(sessRows.length).toBe(2);

		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("VAL-CROSS-007: Same project bootstrapped then used live — counts accurate", async () => {
		const projectId = "proj-same-7";
		await sendIngest(
			{ sessionId: "bootstrap-7", projectId, projectName: "Same", conversation: "hello" },
			{ workerUrl: WORKER_URL, apiKey: TEST_API_KEY, fetch: fetchAdapter },
		);

		const tmpDir = mkdtempSync(join(tmpdir(), "cross-007-"));
		const innerDir = join(tmpDir, projectId);
		mkdirSync(innerDir);
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["-C", innerDir, "init"]);
		execFileSync("git", ["-C", innerDir, "remote", "add", "origin", `https://${projectId}.git`]);
		const transcriptPath = join(innerDir, "transcript.jsonl");
		writeFileSync(
			transcriptPath,
			`${JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] })}\n`,
			"utf-8",
		);

		const oldApiKey = process.env.DIVMEMORY_API_KEY;
		const oldWorkerUrl = process.env.DIVMEMORY_WORKER_URL;
		process.env.DIVMEMORY_API_KEY = TEST_API_KEY;
		process.env.DIVMEMORY_WORKER_URL = WORKER_URL;

		const { processSessionEnd } = await import("../plugin/scripts/session-end.mjs");
		await processSessionEnd(
			JSON.stringify({
				session_id: "live-7",
				cwd: innerDir,
				transcript_path: transcriptPath,
				hook_event_name: "SessionEnd",
			}),
			{ fetch: fetchAdapter, stderr: () => {}, stdout: () => {} },
		);

		process.env.DIVMEMORY_API_KEY = oldApiKey ?? undefined;
		process.env.DIVMEMORY_WORKER_URL = oldWorkerUrl ?? undefined;

		const proj = testDb.db.select().from(projects).where(eq(projects.id, projectId)).get();
		expect(proj?.sessionCount).toBe(2);

		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});
});

describe("Cross-Area — API Key Rotation", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let app: ReturnType<typeof createFullWorkerApp>;

	beforeEach(() => {
		testDb = createTestDb();
		app = createFullWorkerApp(testDb.db);
		mockGlobalFetch();
	});

	afterEach(() => {
		restoreGlobalFetch();
	});

	it("VAL-CROSS-008: Old API key rejected after rotation", async () => {
		const fetchWithNewKey = appFetchAdapter(app, { DIVMEMORY_API_KEY: "new-key" });
		const result = await sendIngest(
			{ sessionId: "sess-008", projectId: "proj-008", projectName: "008", conversation: "hello" },
			{ workerUrl: WORKER_URL, apiKey: "old-key", fetch: fetchWithNewKey },
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("401");
	});

	it("VAL-CROSS-009: New API key accepted after rotation", async () => {
		const fetchWithNewKey = appFetchAdapter(app, { DIVMEMORY_API_KEY: "new-key" });
		const result = await sendIngest(
			{ sessionId: "sess-009", projectId: "proj-009", projectName: "009", conversation: "hello" },
			{ workerUrl: WORKER_URL, apiKey: "new-key", fetch: fetchWithNewKey },
		);
		expect(result.ok).toBe(true);
	});

	it("VAL-CROSS-010: Rotation mid-bootstrap doesn't corrupt data", async () => {
		const fetchWithOldKey = appFetchAdapter(app, { DIVMEMORY_API_KEY: "old-key-010" });
		await sendIngest(
			{ sessionId: "sess-010", projectId: "proj-010", projectName: "010", conversation: "hello" },
			{ workerUrl: WORKER_URL, apiKey: "old-key-010", fetch: fetchWithOldKey },
		);

		const fetchWithNewKey = appFetchAdapter(app, { DIVMEMORY_API_KEY: "new-key-010" });
		const result = await sendIngest(
			{
				sessionId: "sess-010-2",
				projectId: "proj-010",
				projectName: "010",
				conversation: "hello again",
			},
			{ workerUrl: WORKER_URL, apiKey: "old-key-010", fetch: fetchWithNewKey },
		);
		expect(result.ok).toBe(false);

		const proj = testDb.db.select().from(projects).where(eq(projects.id, "proj-010")).get();
		expect(proj?.sessionCount).toBe(1);
	});
});

describe("Cross-Area — Worker Crash Recovery", () => {
	it("VAL-CROSS-011: Worker 502, CLI sendIngest retries or reports gracefully", async () => {
		const fetch502 = () => Promise.resolve(new Response("Bad Gateway", { status: 502 }));
		const result = await sendIngest(
			{ sessionId: "sess-011", projectId: "proj-011", projectName: "011", conversation: "hello" },
			{ workerUrl: WORKER_URL, apiKey: TEST_API_KEY, fetch: fetch502 },
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("502");
	});

	it("VAL-CROSS-012: Worker timeout, context fetch falls back to empty context", async () => {
		const { processSessionStart } = await import("../plugin/scripts/session-start.mjs");
		const tmpDivmemoryHome = mkdtempSync(join(tmpdir(), "cross-012-home-"));
		const oldDivmemoryHome = process.env.DIVMEMORY_HOME;
		const oldApiKey = process.env.DIVMEMORY_API_KEY;
		const capturedStdout: string[] = [];
		const capturedStderr: string[] = [];

		try {
			process.env.DIVMEMORY_HOME = tmpDivmemoryHome;
			process.env.DIVMEMORY_API_KEY = "test-api-key";
			const timeoutFetch = () => Promise.reject(new Error("AbortError: timeout"));
			const result = await processSessionStart(
				JSON.stringify({ session_id: "sess-012", cwd: ".", hook_event_name: "SessionStart" }),
				{
					fetch: timeoutFetch,
					stderr: (s: string) => capturedStderr.push(s),
					stdout: (s: string) => capturedStdout.push(s),
				},
			);

			expect(result.exitCode).toBe(0);
			expect(capturedStdout.join("")).toBe("\n");
		} finally {
			if (oldDivmemoryHome === undefined) {
				delete process.env.DIVMEMORY_HOME;
			} else {
				process.env.DIVMEMORY_HOME = oldDivmemoryHome;
			}
			if (oldApiKey === undefined) {
				delete process.env.DIVMEMORY_API_KEY;
			} else {
				process.env.DIVMEMORY_API_KEY = oldApiKey;
			}
			rmSync(tmpDivmemoryHome, { recursive: true, force: true });
		}
	});
});
