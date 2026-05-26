import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { bearerAuth, hybridAuth } from "../auth";
import { memories } from "../schema";
import { createTestDb } from "../test-helpers";
import { createMemoriesRoute } from "./memories";

const TEST_API_KEY = "test-api-key-123";
const TEST_PASSWORD = "test-web-password-456";
const COOKIE_SECRET = "test-cookie-secret-789";

/* ───────── helpers ───────── */

function createMemoriesApp(db: ReturnType<typeof drizzle>) {
	const app = new Hono<{ Bindings: { DB: typeof db; DIVMEMORY_API_KEY: string } }>();
	app.use("/memories/*", bearerAuth("divmemory_session"));
	app.use("/memories", bearerAuth("divmemory_session"));
	// Bearer token bypasses CSRF; API tests focus on CRUD behavior
	createMemoriesRoute(app, db);
	return app;
}

function createWebApp(db: ReturnType<typeof drizzle>) {
	const app = new Hono<{
		Bindings: {
			DB: typeof db;
			DIVMEMORY_API_KEY: string;
			DIVMEMORY_WEB_PASSWORD: string;
			COOKIE_SECRET: string;
		};
	}>();
	app.use("/memories/*", hybridAuth("divmemory_session"));
	app.use("/memories", hybridAuth("divmemory_session"));
	// API tests with cookie via hybridAuth; CSRF tested separately in auth tests
	createMemoriesRoute(app, db);
	return app;
}

function envVars() {
	return {
		DIVMEMORY_API_KEY: TEST_API_KEY,
		DIVMEMORY_WEB_PASSWORD: TEST_PASSWORD,
		COOKIE_SECRET,
	};
}

function authHeaders() {
	return { Authorization: `Bearer ${TEST_API_KEY}`, "Content-Type": "application/json" };
}

function webEnvVars() {
	return {
		DIVMEMORY_API_KEY: TEST_API_KEY,
		DIVMEMORY_WEB_PASSWORD: TEST_PASSWORD,
		COOKIE_SECRET,
	};
}

async function signSession(secret: string, payload: { exp?: number }): Promise<string> {
	const payloadStr = JSON.stringify(payload);
	const payloadB64 = btoa(payloadStr);
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadStr));
	const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
	return `${payloadB64}.${sigB64}`;
}

async function cookieHeaders() {
	const secret = COOKIE_SECRET;
	const cookie = await signSession(secret, { exp: Math.floor(Date.now() / 1000) + 3600 });
	return {
		Cookie: `divmemory_session=${cookie}`,
		"X-CSRF-Token": "",
		"Content-Type": "application/json",
	};
}

let _seedCounter = 0;

function seedProject(
	sqlite: { run(sql: string, ...args: unknown[]): unknown },
	projectId: string,
	name?: string,
) {
	sqlite.run(
		"INSERT OR IGNORE INTO projects (id, name, session_count, created_at, last_seen) VALUES (?, ?, ?, ?, ?)",
		projectId,
		name || projectId,
		0,
		new Date().toISOString(),
		new Date().toISOString(),
	);
}

function seedSession(
	sqlite: { run(sql: string, ...args: unknown[]): unknown },
	projectId: string,
	id?: string,
) {
	const sid = id || `sess-${projectId}-${++_seedCounter}`;
	sqlite.run(
		"INSERT OR IGNORE INTO sessions (id, project_id, source, raw_text, consolidated, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		sid,
		projectId,
		"droid",
		"seed",
		1,
		new Date().toISOString(),
	);
	return sid;
}

function seedMemory(
	sqlite: { run(sql: string, ...args: unknown[]): unknown },
	projectId: string,
	content: string,
	overrides?: {
		id?: string;
		topic?: string;
		confidence?: number;
		curated?: number;
		status?: string;
		updatedAt?: string;
	},
) {
	const sid = seedSession(sqlite, projectId);
	const id = overrides?.id || crypto.randomUUID();
	sqlite.run(
		"INSERT INTO memories (id, project_id, source_session, topic, content, confidence, curated, consolidated, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id,
		projectId,
		sid,
		overrides?.topic ?? "general",
		content,
		overrides?.confidence ?? 0.9,
		overrides?.curated ?? 0,
		1,
		overrides?.status ?? "active",
		new Date().toISOString(),
		overrides?.updatedAt ?? new Date().toISOString(),
	);
	return id;
}

/* ───────── GET /memories ───────── */

describe("POST /memories", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let sqlite: ReturnType<typeof createTestDb>["sqlite"];

	beforeEach(() => {
		_seedCounter = 0;
		testDb = createTestDb();
		sqlite = testDb.sqlite;
	});

	it("creates a curated manual memory with confidence 1.0", async () => {
		const app = createMemoriesApp(testDb.db);
		const req = new Request("http://localhost/memories", {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				project_id: "manual-proj",
				project_name: "Manual Project",
				topic: "decisions",
				content: "Use Droid-only plugin hooks for divmemory v1.",
			}),
		});

		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { ok: boolean; id: string; curated: number };
		expect(body.ok).toBe(true);
		expect(body.curated).toBe(1);

		const row = testDb.db.select().from(memories).where(eq(memories.id, body.id)).get() as
			| {
					projectId: string;
					topic: string;
					content: string;
					confidence: number;
					curated: number;
					status: string;
			  }
			| undefined;
		expect(row).toMatchObject({
			projectId: "manual-proj",
			topic: "decisions",
			content: "Use Droid-only plugin hooks for divmemory v1.",
			confidence: 1,
			curated: 1,
			status: "active",
		});

		const session = sqlite
			.query("SELECT source FROM sessions WHERE id = ?")
			.get(`manual:${body.id}`) as { source?: string } | undefined;
		expect(session?.source).toBe("manual-add");
	});

	it("defaults manual memory topic to general", async () => {
		const app = createMemoriesApp(testDb.db);
		const req = new Request("http://localhost/memories", {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				project_id: "manual-default",
				content: "Remember this plain fact.",
			}),
		});

		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string };
		const row = testDb.db.select().from(memories).where(eq(memories.id, body.id)).get() as
			| { topic: string }
			| undefined;
		expect(row?.topic).toBe("general");
	});

	it("rejects invalid manual memory topic before writing", async () => {
		const app = createMemoriesApp(testDb.db);
		const req = new Request("http://localhost/memories", {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				project_id: "manual-bad",
				topic: "not-a-topic",
				content: "Bad topic fact.",
			}),
		});

		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(400);
	});

	it("dedups similar manual facts without overwriting existing content", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "manual-dedup");
		const existingId = seedMemory(sqlite, "manual-dedup", "Use Vitest for unit testing.", {
			curated: 0,
			confidence: 0.8,
			updatedAt: "2026-05-18T00:00:00.000Z",
		});

		const req = new Request("http://localhost/memories", {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				project_id: "manual-dedup",
				topic: "preferences",
				content: "Use Vitest for unit testing in this repository.",
			}),
		});

		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; deduped: boolean };
		expect(body).toMatchObject({ id: existingId, deduped: true });

		const rows = testDb.db
			.select()
			.from(memories)
			.where(eq(memories.projectId, "manual-dedup"))
			.all() as Array<{ id: string; content: string; curated: number; confidence: number }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: existingId,
			content: "Use Vitest for unit testing.",
			curated: 1,
			confidence: 1,
		});
	});
});

describe("GET /memories", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let sqlite: ReturnType<typeof createTestDb>["sqlite"];

	beforeEach(() => {
		_seedCounter = 0;
		testDb = createTestDb();
		sqlite = testDb.sqlite;
	});

	it("returns 401 when missing auth", async () => {
		const app = createMemoriesApp(testDb.db);
		const req = new Request("http://localhost/memories?project=test");
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(401);
	});

	it("returns 401 with invalid Bearer token", async () => {
		const app = createMemoriesApp(testDb.db);
		const req = new Request("http://localhost/memories?project=test", {
			headers: { Authorization: "Bearer wrong" },
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(401);
	});

	it("passes with valid Bearer token", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "proj");
		seedMemory(sqlite, "proj", "Test fact");
		const req = new Request("http://localhost/memories?project=proj", {
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
	});

	it("passes with valid cookie", async () => {
		const app = createWebApp(testDb.db);
		seedProject(sqlite, "web-proj");
		seedMemory(sqlite, "web-proj", "Cookie fact");
		const headers = await cookieHeaders();
		const req = new Request("http://localhost/memories?project=web-proj", {
			headers,
		});
		const res = await app.fetch(req, webEnvVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
	});

	it("filter by project_id — returns only matching project memories (VAL-API-053)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "proj-a");
		seedProject(sqlite, "proj-b");
		seedMemory(sqlite, "proj-a", "Fact A");
		seedMemory(sqlite, "proj-b", "Fact B");

		const req = new Request("http://localhost/memories?project=proj-a", {
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			projects: Array<{ id: string; topics: Record<string, unknown[]> }>;
		};
		expect(body.projects).toHaveLength(1);
		expect(body.projects[0].id).toBe("proj-a");
		// Should contain Fact A, not Fact B
		const facts = Object.values(body.projects[0].topics).flat();
		const contents = facts.map((f: unknown) => (f as { content: string }).content);
		expect(contents).toContain("Fact A");
		expect(contents).not.toContain("Fact B");
	});

	it("search by substring — case-insensitive match on content (VAL-API-054)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "search-proj");
		seedMemory(sqlite, "search-proj", "Use Vitest for testing");
		seedMemory(sqlite, "search-proj", "Use Jest for snapshots");

		const req = new Request("http://localhost/memories?project=search-proj&search=vitest", {
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: Array<{ topics: Record<string, unknown[]> }> };
		const facts = Object.values(body.projects[0].topics).flat();
		const contents = facts.map((f: unknown) => (f as { content: string }).content);
		expect(contents).toContain("Use Vitest for testing");
		expect(contents).not.toContain("Use Jest for snapshots");
	});

	it("defaults to status='active' only (VAL-API-055)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "status-proj");
		seedMemory(sqlite, "status-proj", "Active fact 1");
		seedMemory(sqlite, "status-proj", "Active fact 2");
		seedMemory(sqlite, "status-proj", "Archived fact", { status: "archived" });

		const req = new Request("http://localhost/memories?project=status-proj", {
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: Array<{ topics: Record<string, unknown[]> }> };
		const facts = Object.values(body.projects[0].topics).flat();
		expect(facts).toHaveLength(2);
		const contents = facts.map((f: unknown) => (f as { content: string }).content);
		expect(contents).toContain("Active fact 1");
		expect(contents).not.toContain("Archived fact");
	});

	it("?status=archived returns archived only (VAL-API-056)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "status-proj-2");
		seedMemory(sqlite, "status-proj-2", "Active fact");
		seedMemory(sqlite, "status-proj-2", "Archived fact 1", { status: "archived" });
		seedMemory(sqlite, "status-proj-2", "Archived fact 2", { status: "archived" });

		const req = new Request("http://localhost/memories?project=status-proj-2&status=archived", {
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: Array<{ topics: Record<string, unknown[]> }> };
		const facts = Object.values(body.projects[0].topics).flat();
		expect(facts).toHaveLength(2);
		const contents = facts.map((f: unknown) => (f as { content: string }).content);
		expect(contents).toContain("Archived fact 1");
		expect(contents).toContain("Archived fact 2");
		expect(contents).not.toContain("Active fact");
	});

	it("grouped by project and topic (VAL-API-057)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "group-proj");
		seedMemory(sqlite, "group-proj", "Decision A", { topic: "decisions" });
		seedMemory(sqlite, "group-proj", "Decision B", { topic: "decisions" });
		seedMemory(sqlite, "group-proj", "Context A", { topic: "project_context" });

		const req = new Request("http://localhost/memories?project=group-proj", {
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			projects: Array<{
				id: string;
				name: string;
				topics: Record<string, Array<{ content: string }>>;
			}>;
		};
		expect(body.projects).toHaveLength(1);
		const topics = body.projects[0].topics;
		expect(topics.decisions).toHaveLength(2);
		expect(topics.project_context).toHaveLength(1);
		expect(topics.decisions.map((f) => f.content)).toContain("Decision A");
		expect(topics.project_context.map((f) => f.content)).toContain("Context A");
	});

	it("returns 200 with empty results for project with no memories (VAL-API-061)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "no-mem");

		const req = new Request("http://localhost/memories?project=no-mem", {
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: unknown[] };
		expect(body.projects).toHaveLength(0);
	});

	it("returns 200 with empty results for nonexistent project (VAL-API-062)", async () => {
		const app = createMemoriesApp(testDb.db);
		const req = new Request("http://localhost/memories?project=nonexistent-id", {
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: unknown[] };
		expect(body.projects).toHaveLength(0);
	});

	it("search with zero matches returns 200 empty (VAL-API-096)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "search-empty");
		seedMemory(sqlite, "search-empty", "Some fact");

		const req = new Request(
			"http://localhost/memories?project=search-empty&search=completelyunmatchedstring123",
			{
				headers: authHeaders(),
			},
		);
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: unknown[] };
		expect(body.projects).toHaveLength(0);
	});
});

/* ───────── PATCH /memories/:id ───────── */

describe("PATCH /memories/:id", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let sqlite: ReturnType<typeof createTestDb>["sqlite"];

	beforeEach(() => {
		_seedCounter = 0;
		testDb = createTestDb();
		sqlite = testDb.sqlite;
	});

	it("returns 401 without auth (VAL-API-068)", async () => {
		const app = createMemoriesApp(testDb.db);
		const req = new Request("http://localhost/memories/some-id", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "Updated" }),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(401);
	});

	it("passes with valid Bearer token (VAL-API-069)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "patch-proj");
		const id = seedMemory(sqlite, "patch-proj", "Original");
		const req = new Request(`http://localhost/memories/${id}`, {
			method: "PATCH",
			headers: authHeaders(),
			body: JSON.stringify({ content: "Updated" }),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
	});

	it("passes with valid cookie (VAL-API-070)", async () => {
		const app = createWebApp(testDb.db);
		seedProject(sqlite, "web-patch");
		const id = seedMemory(sqlite, "web-patch", "Web original");
		const headers = await cookieHeaders();
		const req = new Request(`http://localhost/memories/${id}`, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ content: "Updated web" }),
		});
		const res = await app.fetch(req, webEnvVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
	});

	it("returns 404 for non-existent ID (VAL-API-067)", async () => {
		const app = createMemoriesApp(testDb.db);
		const req = new Request("http://localhost/memories/nonexistent-uuid", {
			method: "PATCH",
			headers: authHeaders(),
			body: JSON.stringify({ content: "Updated" }),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(404);
	});

	it("edit content updates content and auto-sets curated=1 (VAL-API-063)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "patch-proj");
		const id = seedMemory(sqlite, "patch-proj", "Before edit", { curated: 0, confidence: 0.8 });

		const req = new Request(`http://localhost/memories/${id}`, {
			method: "PATCH",
			headers: authHeaders(),
			body: JSON.stringify({ content: "After edit" }),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);

		const result = testDb.db.select().from(memories).where(eq(memories.id, id)).get() as
			| {
					content: string;
					curated: number;
					confidence: number;
			  }
			| undefined;
		expect(result?.content).toBe("After edit");
		expect(result?.curated).toBe(1);
		expect(result?.confidence).toBe(1.0);
	});

	it("edit topic changes topic and auto-sets curated=1 (VAL-API-064)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "patch-topic");
		const id = seedMemory(sqlite, "patch-topic", "Some fact", { topic: "general", curated: 0 });

		const req = new Request(`http://localhost/memories/${id}`, {
			method: "PATCH",
			headers: authHeaders(),
			body: JSON.stringify({ topic: "decisions" }),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);

		const result = testDb.db.select().from(memories).where(eq(memories.id, id)).get() as
			| {
					topic: string;
					curated: number;
			  }
			| undefined;
		expect(result?.topic).toBe("decisions");
		expect(result?.curated).toBe(1);
	});

	it("edit both content and topic simultaneously (VAL-API-065)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "patch-both");
		const id = seedMemory(sqlite, "patch-both", "Both before", { topic: "general", curated: 0 });

		const req = new Request(`http://localhost/memories/${id}`, {
			method: "PATCH",
			headers: authHeaders(),
			body: JSON.stringify({ content: "Both after", topic: "preferences" }),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);

		const result = testDb.db.select().from(memories).where(eq(memories.id, id)).get() as
			| {
					content: string;
					topic: string;
					curated: number;
			  }
			| undefined;
		expect(result?.content).toBe("Both after");
		expect(result?.topic).toBe("preferences");
		expect(result?.curated).toBe(1);
	});

	it("restore archived memory to active (VAL-API-066)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "restore-proj");
		const id = seedMemory(sqlite, "restore-proj", "Archived fact", {
			status: "archived",
			curated: 1,
		});

		const req = new Request(`http://localhost/memories/${id}`, {
			method: "PATCH",
			headers: authHeaders(),
			body: JSON.stringify({ status: "active" }),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);

		const result = testDb.db.select().from(memories).where(eq(memories.id, id)).get() as
			| {
					status: string;
					curated: number;
			  }
			| undefined;
		expect(result?.status).toBe("active");
		expect(result?.curated).toBe(1);
	});

	it("returns 400 for invalid topic with valid topic list (VAL-API-097)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "invalid-topic");
		const id = seedMemory(sqlite, "invalid-topic", "Fact");

		const req = new Request(`http://localhost/memories/${id}`, {
			method: "PATCH",
			headers: authHeaders(),
			body: JSON.stringify({ topic: "invalid_topic_name" }),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("invalid");
		// Verify memory unchanged
		const result = testDb.db.select().from(memories).where(eq(memories.id, id)).get() as
			| {
					topic: string;
			  }
			| undefined;
		expect(result?.topic).toBe("general");
	});

	it("handles empty body gracefully (VAL-API-071)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "empty-patch");
		const id = seedMemory(sqlite, "empty-patch", "Fact");

		const req = new Request(`http://localhost/memories/${id}`, {
			method: "PATCH",
			headers: authHeaders(),
			body: JSON.stringify({}),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect([200, 400]).toContain(res.status);
	});
});

/* ───────── DELETE /memories/:id ───────── */

describe("DELETE /memories/:id", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let sqlite: ReturnType<typeof createTestDb>["sqlite"];

	beforeEach(() => {
		_seedCounter = 0;
		testDb = createTestDb();
		sqlite = testDb.sqlite;
	});

	it("returns 401 without auth (VAL-API-075)", async () => {
		const app = createMemoriesApp(testDb.db);
		const req = new Request("http://localhost/memories/some-id", {
			method: "DELETE",
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(401);
	});

	it("passes with valid Bearer token (VAL-API-076)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "del-bearer");
		const id = seedMemory(sqlite, "del-bearer", "To delete", { curated: 0 });
		const req = new Request(`http://localhost/memories/${id}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
	});

	it("passes with valid cookie (VAL-API-077)", async () => {
		const app = createWebApp(testDb.db);
		seedProject(sqlite, "web-del");
		const id = seedMemory(sqlite, "web-del", "Cookie delete", { curated: 1 });
		const headers = await cookieHeaders();
		const req = new Request(`http://localhost/memories/${id}`, {
			method: "DELETE",
			headers,
		});
		const res = await app.fetch(req, webEnvVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);
	});

	it("returns 404 for non-existent ID (VAL-API-074)", async () => {
		const app = createMemoriesApp(testDb.db);
		const req = new Request("http://localhost/memories/nonexistent-id", {
			method: "DELETE",
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(404);
	});

	it("hard-deletes auto-extracted (curated=0) (VAL-API-072)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "hard-del");
		const id = seedMemory(sqlite, "hard-del", "Auto fact", { curated: 0 });

		const req = new Request(`http://localhost/memories/${id}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);

		const result = testDb.db.select().from(memories).where(eq(memories.id, id)).get();
		expect(result).toBeUndefined();
	});

	it("soft-archives curated (curated=1) (VAL-API-073)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "soft-del");
		const id = seedMemory(sqlite, "soft-del", "Curated fact", { curated: 1 });

		const req = new Request(`http://localhost/memories/${id}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);

		const result = testDb.db.select().from(memories).where(eq(memories.id, id)).get() as
			| {
					status: string;
					curated: number;
			  }
			| undefined;
		expect(result?.status).toBe("archived");
		expect(result?.curated).toBe(1);
	});

	it("double-delete archived curated is idempotent (VAL-API-078)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "double-del");
		const id = seedMemory(sqlite, "double-del", "Already archived", {
			curated: 1,
			status: "archived",
		});

		const req = new Request(`http://localhost/memories/${id}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect([200, 404]).toContain(res.status);

		const result = testDb.db.select().from(memories).where(eq(memories.id, id)).get() as
			| {
					status: string;
					curated: number;
			  }
			| undefined;
		expect(result?.status).toBe("archived");
		expect(result?.curated).toBe(1);
	});

	it("delete archived auto-extracted still hard-deletes (VAL-API-079)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "auto-arch");
		const id = seedMemory(sqlite, "auto-arch", "Auto archived", { curated: 0, status: "archived" });

		const req = new Request(`http://localhost/memories/${id}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);

		const result = testDb.db.select().from(memories).where(eq(memories.id, id)).get();
		expect(result).toBeUndefined();
	});

	it("archiving curated cascades to near-duplicate auto-extracted memories (VAL-API-080)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "cascade-proj");
		const curatedId = seedMemory(
			sqlite,
			"cascade-proj",
			"Use Vitest for unit testing in this project.",
			{
				curated: 1,
				confidence: 1,
			},
		);
		const nearDupId = seedMemory(
			sqlite,
			"cascade-proj",
			"Use Vitest for unit testing in this repository project.",
			{
				curated: 0,
				confidence: 0.8,
			},
		);
		const unrelatedId = seedMemory(
			sqlite,
			"cascade-proj",
			"The project uses Jest for integration tests.",
			{
				curated: 0,
				confidence: 0.8,
			},
		);

		const req = new Request(`http://localhost/memories/${curatedId}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);

		const curatedRow = testDb.db.select().from(memories).where(eq(memories.id, curatedId)).get() as
			| { status: string }
			| undefined;
		expect(curatedRow?.status).toBe("archived");

		const nearDupRow = testDb.db.select().from(memories).where(eq(memories.id, nearDupId)).get();
		expect(nearDupRow).toBeUndefined();

		const unrelatedRow = testDb.db
			.select()
			.from(memories)
			.where(eq(memories.id, unrelatedId))
			.get() as { status: string } | undefined;
		expect(unrelatedRow?.status).toBe("active");
	});

	it("archiving curated with no auto-extracted near-duplicates behaves normally (VAL-API-081)", async () => {
		const app = createMemoriesApp(testDb.db);
		seedProject(sqlite, "no-cascade");
		const curatedId = seedMemory(sqlite, "no-cascade", "A unique curated fact.", {
			curated: 1,
			confidence: 1,
		});

		const req = new Request(`http://localhost/memories/${curatedId}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		const res = await app.fetch(req, envVars() as unknown as Record<string, string>);
		expect(res.status).toBe(200);

		const curatedRow = testDb.db.select().from(memories).where(eq(memories.id, curatedId)).get() as
			| { status: string }
			| undefined;
		expect(curatedRow?.status).toBe("archived");
	});
});
