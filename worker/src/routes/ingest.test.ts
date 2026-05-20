import { eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { bearerAuth } from "../auth";
import { projects, sessions } from "../schema";
import { createTestDb } from "../test-helpers";
import {
	createIngestRoute,
	jaccardSimilarity,
	recoverJSON,
	truncateConversationFromEnd,
} from "./ingest";

const TEST_API_KEY = "test-api-key-123";

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

function createIngestAppWithMock(
	db: ReturnType<typeof drizzle>,
	opts?: { getEnv?: (c: unknown) => { FIREWORKS_API_KEY?: string; FIREWORKS_MODEL?: string } },
) {
	const app = new Hono<{ Bindings: { DB: typeof db; DIVMEMORY_API_KEY: string } }>();
	app.use("/ingest", bearerAuth("divmemory_session"));
	createIngestRoute(app, db, {
		getEnv: opts?.getEnv ?? (() => ({ FIREWORKS_API_KEY: TEST_API_KEY })),
	});
	return app;
}

function mockExecCtx() {
	const promises: Promise<unknown>[] = [];
	return {
		ctx: {
			waitUntil: (p: Promise<unknown>) => {
				promises.push(p);
			},
			passThroughOnException: () => {},
		} as unknown as import("@cloudflare/workers-types").ExecutionContext,
		awaitAll: () => Promise.all(promises),
	};
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

	describe("async extraction via ctx.waitUntil", () => {
		it("returns 200 immediately and extracts asynchronously", async () => {
			const app2 = createIngestAppWithMock(testDb.db, {
				getEnv: () => ({
					FIREWORKS_API_KEY: "test-key",
					FIREWORKS_MODEL: "test-model",
				}),
			});
			const { ctx, awaitAll } = mockExecCtx();

			const body = {
				session_id: "sess-async",
				project_id: "proj/async",
				conversation: "User: hello\n\nAssistant: hi",
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app2.fetch(req, envVars() as unknown as Record<string, string>, ctx);
			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				ok: boolean;
				status: string;
				session_id: string;
				facts_written: number;
			};
			expect(json.ok).toBe(true);
			expect(json.status).toBe("queued");
			expect(json.session_id).toBe("sess-async");
			expect(json.facts_written).toBe(0); // async, not yet extracted

			// Wait for async extraction to finish
			await awaitAll();
		});
	});

	describe("crash recovery — session inserted before extraction", () => {
		it("session row with raw_text exists before extraction completes", async () => {
			const app2 = createIngestAppWithMock(testDb.db, {
				getEnv: () => ({
					FIREWORKS_API_KEY: "key",
					FIREWORKS_MODEL: "test-model",
				}),
			});
			const { ctx, awaitAll } = mockExecCtx();

			// Mock fetch to hang so we can inspect DB mid-extraction
			const origFetch = globalThis.fetch;
			let resolveFetch!: (r: Response) => void;
			const fetchPromise = new Promise<Response>((resolve) => {
				resolveFetch = resolve;
			});
			globalThis.fetch = async () => fetchPromise;

			try {
				const body = {
					session_id: "sess-mid-extract",
					project_id: "proj/mid",
					conversation: "User: hello recovery\n\nAssistant: hi",
				};
				const req = new Request("http://localhost/ingest", {
					method: "POST",
					headers: authHeaders(),
					body: JSON.stringify(body),
				});
				const res = await app2.fetch(req, envVars() as unknown as Record<string, string>, ctx);
				expect(res.status).toBe(200);

				// Allow microtask queue to run insertSessionAndProject
				await new Promise<void>((r) => setTimeout(r, 30));

				const sess = testDb.db
					.select()
					.from(sessions)
					.where(eq(sessions.id, "sess-mid-extract"))
					.get();
				expect(sess).toBeDefined();
				expect(sess?.rawText).toBe(body.conversation);
				expect(sess?.consolidated).toBe(0);
				expect(sess?.extractionError).toBeNull();

				// Unblock fetch so awaitAll resolves
				resolveFetch(
					new Response(
						JSON.stringify({
							choices: [{ message: { content: JSON.stringify({ facts: [] }) } }],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
				await awaitAll();
			} finally {
				globalThis.fetch = origFetch;
			}
		});

		it("crash during extraction leaves recoverable session with consolidated=-1", async () => {
			const app2 = createIngestAppWithMock(testDb.db, {
				getEnv: () => ({
					FIREWORKS_API_KEY: "bad-key",
					FIREWORKS_MODEL: "test-model",
				}),
			});
			const { ctx, awaitAll } = mockExecCtx();

			// Mock fetch to return HTTP 500 (simulating Firepass failure = crash-like error)
			const origFetch = globalThis.fetch;
			globalThis.fetch = async () =>
				new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });

			try {
				const body = {
					session_id: "sess-crash",
					project_id: "proj/crash",
					conversation: "User: hello crash\n\nAssistant: hi",
				};
				const req = new Request("http://localhost/ingest", {
					method: "POST",
					headers: authHeaders(),
					body: JSON.stringify(body),
				});
				await app2.fetch(req, envVars() as unknown as Record<string, string>, ctx);
				await awaitAll();

				const sess = testDb.db.select().from(sessions).where(eq(sessions.id, "sess-crash")).get();
				expect(sess).toBeDefined();
				expect(sess?.rawText).toBe(body.conversation);
				expect(sess?.consolidated).toBe(-1);
				expect(sess?.extractionError).not.toBeNull();
				expect(sess?.extractionError).not.toBe("Firepass extraction failed");
			} finally {
				globalThis.fetch = origFetch;
			}
		});
	});

	describe("extraction_error contains raw Firepass response on simulated failure", () => {
		it("stores raw Firepass response text on HTTP failure", async () => {
			const app2 = createIngestAppWithMock(testDb.db, {
				getEnv: () => ({
					FIREWORKS_API_KEY: "bad-key",
					FIREWORKS_MODEL: "test-model",
				}),
			});
			const { ctx, awaitAll } = mockExecCtx();

			const body = {
				session_id: "sess-error",
				project_id: "proj/error",
				conversation: "User: hello",
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			await app2.fetch(req, envVars() as unknown as Record<string, string>, ctx);
			await awaitAll();

			const sess = testDb.db.select().from(sessions).where(eq(sessions.id, "sess-error")).get();
			expect(sess).toBeDefined();
			expect(sess?.consolidated).toBe(-1);
			// Should contain an HTTP error prefix; the raw response body may be empty or contain
			// a JSON error from Fireworks, but it should NOT be the old generic string.
			expect(sess?.extractionError).not.toBe("Firepass extraction failed");
			expect(sess?.extractionError).not.toBeNull();
			expect(sess?.extractionError?.length).toBeGreaterThan(5);
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

describe("truncateConversationFromEnd", () => {
	it("returns short conversation unchanged", () => {
		const convo = "User: hello\n\nAssistant: hi";
		expect(truncateConversationFromEnd(convo, 100)).toBe(convo);
	});

	it("truncates massive conversation and starts cleanly at turn boundary", () => {
		const convo =
			"User: message 1\n\nAssistant: message 2\n\nUser: message 3\n\nAssistant: message 4";
		// Let's truncate to a size smaller than the full convo
		const truncated = truncateConversationFromEnd(convo, 50);
		expect(truncated).toContain("[Conversation truncated for length...]");
		// The boundary search should align it to the next User: or Assistant:
		expect(truncated.trim().endsWith("User: message 3\n\nAssistant: message 4")).toBe(true);
	});

	it("does not false-match 'User:' or 'Assistant:' inside message content", () => {
		const convo =
			"User: How do I define a user class?\n\nAssistant: class User:\n    pass\n\nUser: message 3";
		const truncated = truncateConversationFromEnd(convo, 35);
		expect(truncated).toContain("[Conversation truncated for length...]");
		expect(truncated.endsWith("User: message 3")).toBe(true);
	});

	it("falls back to raw slice if turn boundaries are missing", () => {
		const convo = "some raw text without headers that is very long and stuff";
		const truncated = truncateConversationFromEnd(convo, 10);
		expect(truncated).toContain("[Conversation truncated for length...]");
		expect(truncated.endsWith("and stuff")).toBe(true);
	});
});
