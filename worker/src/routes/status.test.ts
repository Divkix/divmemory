import type { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { bearerAuth } from "../auth";
import { createTestDb } from "../test-helpers";
import { createStatusRoute } from "./status";

const TEST_API_KEY = "test-api-key-123";

function createStatusApp(db: ReturnType<typeof drizzle>) {
	const app = new Hono<{ Bindings: { DB: typeof db; DIVMEMORY_API_KEY: string } }>();
	app.use("/status", bearerAuth("divmemory_session"));
	createStatusRoute(app, db);
	return app;
}

function authHeaders() {
	return { Authorization: `Bearer ${TEST_API_KEY}` };
}

describe("GET /status", () => {
	let testDb: ReturnType<typeof createTestDb>;

	beforeEach(() => {
		testDb = createTestDb();
		testDb.sqlite.run(
			"INSERT INTO projects (id, name, session_count, created_at, last_seen, consolidation_in_progress) VALUES (?, ?, ?, ?, ?, ?)",
			"proj-a",
			"Project A",
			3,
			"2026-05-19T01:00:00.000Z",
			"2026-05-19T02:00:00.000Z",
			1,
		);
		testDb.sqlite.run(
			"INSERT INTO sessions (id, project_id, source, raw_text, consolidated, extraction_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			"s-pending",
			"proj-a",
			"droid",
			"pending",
			0,
			null,
			"2026-05-19T02:00:00.000Z",
		);
		testDb.sqlite.run(
			"INSERT INTO sessions (id, project_id, source, raw_text, consolidated, extraction_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			"s-error",
			"proj-a",
			"droid",
			"error",
			-1,
			"Firepass failed",
			"2026-05-19T02:10:00.000Z",
		);
		testDb.sqlite.run(
			"INSERT INTO memories (id, project_id, source_session, topic, content, confidence, curated, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			"m-active",
			"proj-a",
			"s-pending",
			"decisions",
			"Active memory",
			0.9,
			0,
			"active",
			"2026-05-19T02:20:00.000Z",
			"2026-05-19T02:20:00.000Z",
		);
		testDb.sqlite.run(
			"INSERT INTO memories (id, project_id, source_session, topic, content, confidence, curated, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			"m-curated",
			"proj-a",
			"s-pending",
			"preferences",
			"Curated memory",
			1,
			1,
			"active",
			"2026-05-19T02:25:00.000Z",
			"2026-05-19T02:25:00.000Z",
		);
	});

	it("requires bearer auth", async () => {
		const app = createStatusApp(testDb.db);
		const res = await app.fetch(new Request("http://localhost/status"), {
			DIVMEMORY_API_KEY: TEST_API_KEY,
		} as unknown as Record<string, string>);
		expect(res.status).toBe(401);
	});

	it("returns project health, backlog, and memory counts", async () => {
		const app = createStatusApp(testDb.db);
		const res = await app.fetch(
			new Request("http://localhost/status?project=proj-a", { headers: authHeaders() }),
			{ DIVMEMORY_API_KEY: TEST_API_KEY } as unknown as Record<string, string>,
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			project_id: string;
			sessions: { total: number; pending_extraction: number; extraction_errors: number };
			memories: { active: number; curated: number };
			consolidation: { in_progress: boolean };
			last_seen: string;
			last_error: string | null;
		};
		expect(body.project_id).toBe("proj-a");
		expect(body.sessions).toEqual({ total: 2, pending_extraction: 1, extraction_errors: 1 });
		expect(body.memories).toEqual({ active: 2, curated: 1 });
		expect(body.consolidation.in_progress).toBe(true);
		expect(body.last_seen).toBe("2026-05-19T02:00:00.000Z");
		expect(body.last_error).toBe("Firepass failed");
	});

	it("returns global status when project is omitted", async () => {
		const app = createStatusApp(testDb.db);
		const res = await app.fetch(
			new Request("http://localhost/status", { headers: authHeaders() }),
			{ DIVMEMORY_API_KEY: TEST_API_KEY } as unknown as Record<string, string>,
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: { total: number }; sessions: { total: number } };
		expect(body.projects.total).toBe(1);
		expect(body.sessions.total).toBe(2);
	});
});
