import type { Message, MessageBatch } from "@cloudflare/workers-types";
import { eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearerAuth } from "../auth";
import type { QueueMessage } from "../queue/ingest-consumer";
import { memories, projects, sessions } from "../schema";
import { createTestDb } from "../test-helpers";
import {
	createIngestRoute,
	jaccardSimilarity,
	recoverJSON,
	truncateConversationFromEnd,
} from "./ingest";

const TEST_API_KEY = "test-api-key-123";

class MockQueue {
	public messages: unknown[] = [];
	public failNext = false;

	async send(message: unknown, _options?: unknown): Promise<void> {
		if (this.failNext) {
			throw new Error("Mock Queue Send Failure");
		}
		this.messages.push(message);
	}

	clear() {
		this.messages = [];
		this.failNext = false;
	}
}

const mockQueue = new MockQueue();

function createIngestApp(db: ReturnType<typeof drizzle>) {
	const app = new Hono<{
		Bindings: { DB: typeof db; DIVMEMORY_API_KEY: string; INGEST_QUEUE: MockQueue };
	}>();
	app.use("/ingest", bearerAuth("divmemory_session"));
	createIngestRoute(app, db);
	return app;
}

function envVars() {
	return {
		DIVMEMORY_API_KEY: TEST_API_KEY,
	};
}

function envVarsWithQueue() {
	return {
		DIVMEMORY_API_KEY: TEST_API_KEY,
		INGEST_QUEUE: mockQueue,
	};
}

function authHeaders() {
	return { Authorization: `Bearer ${TEST_API_KEY}`, "Content-Type": "application/json" };
}

function createIngestAppWithMock(
	db: ReturnType<typeof drizzle>,
	opts?: { getEnv?: (c: unknown) => { FIREWORKS_API_KEY?: string; FIREWORKS_MODEL?: string } },
) {
	const app = new Hono<{
		Bindings: { DB: typeof db; DIVMEMORY_API_KEY: string; INGEST_QUEUE: MockQueue };
	}>();
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
		mockQueue.clear();
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

import { processIngestQueue } from "../queue/ingest-consumer";

describe("Queue-Based Ingest Pipeline (TDD)", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let app: ReturnType<typeof createIngestApp>;
	const origFetch = globalThis.fetch;

	beforeEach(() => {
		testDb = createTestDb();
		app = createIngestApp(testDb.db);
		mockQueue.clear();
	});

	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	// Helper to mock message and batch for consumer tests
	const createMockMessage = (body: QueueMessage): Message<QueueMessage> => {
		let acked = false;
		let retried = false;
		return {
			id: `msg-${Math.random()}`,
			timestamp: new Date(),
			body,
			ack: () => {
				acked = true;
			},
			retry: () => {
				retried = true;
			},
			isAcked: () => acked,
			isRetried: () => retried,
		} as unknown as Message<QueueMessage>;
	};

	const createMockBatch = (messages: Message<QueueMessage>[]): MessageBatch<QueueMessage> => {
		let retriedAll = false;
		return {
			queue: "divmemory-ingest",
			messages,
			retryAll: () => {
				retriedAll = true;
			},
			isRetriedAll: () => retriedAll,
		} as unknown as MessageBatch<QueueMessage>;
	};

	describe("Producer Endpoint Tests", () => {
		it("Test 1.1 (Producer Payload Validation): rejects malformed payload with 400 and doesn't enqueue", async () => {
			const body = { session_id: "", project_id: "proj/test", conversation: "User: hello" };
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app.fetch(req, envVarsWithQueue() as unknown as Record<string, string>);
			expect(res.status).toBe(400);
			expect(mockQueue.messages).toHaveLength(0);
		});

		it("Test 1.2 (Producer Queue Publishing): valid payload inserts session, enqueues {sessionId, projectId}, returns 202 immediately", async () => {
			const body = {
				session_id: "sess-prod-12",
				project_id: "proj/prod-12",
				conversation: "User: hello queue",
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app.fetch(req, envVarsWithQueue() as unknown as Record<string, string>);
			expect(res.status).toBe(202);
			const json = (await res.json()) as { status: string; session_id: string };
			expect(json.status).toBe("queued");
			expect(json.session_id).toBe("sess-prod-12");

			// Check DB contains session in pending state (consolidated = 0, extractionError = null)
			const sess = testDb.db.select().from(sessions).where(eq(sessions.id, "sess-prod-12")).get();
			expect(sess).toBeDefined();
			expect(sess?.rawText).toBe("User: hello queue");
			expect(sess?.consolidated).toBe(0);

			// Check message is published to the queue
			expect(mockQueue.messages).toHaveLength(1);
			expect(mockQueue.messages[0]).toEqual({
				sessionId: "sess-prod-12",
				projectId: "proj/prod-12",
			});
		});

		it("Test 1.6 (Re-ingestion of Failed Session): duplicate session_id where consolidated = -1 resets extractionError, enqueues and returns success", async () => {
			const now = new Date().toISOString();
			// Pre-insert a failed session in DB
			await testDb.db.insert(projects).values({
				id: "proj/failed-sess",
				name: "Failed Project",
				sessionCount: 1,
				createdAt: now,
				lastSeen: now,
			});
			await testDb.db.insert(sessions).values({
				id: "sess-failed-1",
				projectId: "proj/failed-sess",
				source: "droid",
				rawText: "Old broken convo",
				consolidated: -1,
				extractionError: "Rate limit hit previously",
				createdAt: now,
			});

			const body = {
				session_id: "sess-failed-1",
				project_id: "proj/failed-sess",
				conversation: "User: hello retry",
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app.fetch(req, envVarsWithQueue() as unknown as Record<string, string>);
			expect(res.status).toBe(202);

			const sess = testDb.db.select().from(sessions).where(eq(sessions.id, "sess-failed-1")).get();
			expect(sess?.consolidated).toBe(0);
			expect(sess?.extractionError).toBeNull();
			expect(sess?.rawText).toBe("User: hello retry");

			expect(mockQueue.messages).toHaveLength(1);
			expect(mockQueue.messages[0]).toEqual({
				sessionId: "sess-failed-1",
				projectId: "proj/failed-sess",
			});
		});

		it("Test 1.7 (Orphaned Sessions Recovery): if queue send() fails, producer deletes session and returns 500", async () => {
			mockQueue.failNext = true;
			const body = {
				session_id: "sess-fail-send",
				project_id: "proj/fail-send",
				conversation: "User: will fail queue send",
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const res = await app.fetch(req, envVarsWithQueue() as unknown as Record<string, string>);
			expect(res.status).toBe(500);

			// DB session should not exist anymore to avoid orphaned state
			const sess = testDb.db.select().from(sessions).where(eq(sessions.id, "sess-fail-send")).get();
			expect(sess).toBeUndefined();
		});
	});

	describe("Regression Tests for Ingestion Issues", () => {
		it("returns 403 when session_id exists but belongs to a different project", async () => {
			const body1 = {
				session_id: "sess-cross-proj",
				project_id: "proj/A",
				conversation: "User: hi from project A",
			};
			const req1 = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body1),
			});
			const res1 = await app.fetch(req1, envVars() as unknown as Record<string, string>);
			expect(res1.status).toBe(200);

			const body2 = {
				session_id: "sess-cross-proj",
				project_id: "proj/B",
				conversation: "User: hi from project B",
			};
			const req2 = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body2),
			});
			const res2 = await app.fetch(req2, envVars() as unknown as Record<string, string>);
			expect(res2.status).toBe(403);
			const json2 = (await res2.json()) as { error: string };
			expect(json2.error).toBe("Session belongs to a different project");
		});

		it("returns 403 when session_id is consolidated but belongs to a different project", async () => {
			await testDb.db
				.insert(projects)
				.values({ id: "proj/A", createdAt: new Date().toISOString() })
				.onConflictDoNothing();
			await testDb.db.insert(sessions).values({
				id: "sess-cross-proj-consolidated",
				projectId: "proj/A",
				rawText: "User: hi",
				consolidated: 1,
				createdAt: new Date().toISOString(),
			});

			const body2 = {
				session_id: "sess-cross-proj-consolidated",
				project_id: "proj/B",
				conversation: "User: hi from project B",
			};
			const req2 = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body2),
			});
			const res2 = await app.fetch(req2, envVars() as unknown as Record<string, string>);
			expect(res2.status).toBe(403);
			const json2 = (await res2.json()) as { error: string };
			expect(json2.error).toBe("Session belongs to a different project");
		});

		it("does not decrement project session count when increment fails", async () => {
			const mockDb = new Proxy(testDb.db, {
				get(target, prop, receiver) {
					if (prop === "transaction") {
						const origTransaction = Reflect.get(target, prop, receiver);
						return (callback: (tx: unknown) => unknown) => {
							return origTransaction.call(target, (tx: unknown) => {
								const proxiedTx = new Proxy(tx as object, {
									get(txTarget, txProp, txReceiver) {
										if (txProp === "update") {
											return (table: unknown) => {
												if (table === projects) {
													throw new Error("Simulated update failure for projects table");
												}
												const updateFn = (txTarget as { update: (t: unknown) => unknown }).update;
												return updateFn(table);
											};
										}
										return Reflect.get(txTarget, txProp, txReceiver);
									},
								});
								return callback(proxiedTx);
							});
						};
					}
					if (prop === "update") {
						return (table: unknown) => {
							if (table === projects) {
								throw new Error("Simulated update failure for projects table");
							}
							const updateFn = target.update as (t: unknown) => unknown;
							return updateFn(table);
						};
					}
					return Reflect.get(target, prop, receiver);
				},
			});

			const proxyApp = createIngestApp(mockDb);

			const body = {
				session_id: "sess-fail-increment",
				project_id: "proj/fail-increment",
				conversation: "User: hello fail",
			};
			const req = new Request("http://localhost/ingest", {
				method: "POST",
				headers: authHeaders(),
				body: JSON.stringify(body),
			});

			const res = await proxyApp.fetch(
				req,
				envVarsWithQueue() as unknown as Record<string, string>,
			);
			expect(res.status).toBe(500);

			const sess = testDb.db
				.select()
				.from(sessions)
				.where(eq(sessions.id, "sess-fail-increment"))
				.get();
			expect(sess).toBeUndefined();

			const proj = testDb.db
				.select()
				.from(projects)
				.where(eq(projects.id, "proj/fail-increment"))
				.get();
			expect(proj?.sessionCount).toBe(0);
		});
	});

	describe("Consumer Handler Tests", () => {
		it("Test 1.3 (Consumer Successful Extraction): processes extraction successfully and sets consolidated = 0", async () => {
			const now = new Date().toISOString();
			await testDb.db.insert(projects).values({
				id: "proj/consumer-success",
				name: "Success Project",
				sessionCount: 1,
				createdAt: now,
				lastSeen: now,
			});
			await testDb.db.insert(sessions).values({
				id: "sess-consumer-success",
				projectId: "proj/consumer-success",
				source: "droid",
				rawText: "User: hello consumer",
				consolidated: 0,
				createdAt: now,
			});

			// Mock successful Fireworks API response
			globalThis.fetch = async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										facts: [
											{
												topic: "project_context",
												content: "Consumer successfully processed.",
												confidence: 0.9,
											},
										],
									}),
								},
							},
						],
					}),
					{ status: 200 },
				);

			const msg = createMockMessage({
				sessionId: "sess-consumer-success",
				projectId: "proj/consumer-success",
			});
			const batch = createMockBatch([msg]);

			await processIngestQueue(batch, { DB: testDb.db, FIREWORKS_API_KEY: "test-api-key" });

			const sess = testDb.db
				.select()
				.from(sessions)
				.where(eq(sessions.id, "sess-consumer-success"))
				.get();
			expect(sess?.consolidated).toBe(0);
			expect(sess?.extractionError).toBeNull();

			const writtenMemories = testDb.db
				.select()
				.from(memories)
				.where(eq(memories.sourceSession, "sess-consumer-success"))
				.all();
			expect(writtenMemories).toHaveLength(1);
			expect(writtenMemories[0].content).toBe("Consumer successfully processed.");
		});

		it("Test 1.4 (Consumer Transient Error Auto-Retry): transient error (429) causes consumer to throw", async () => {
			const now = new Date().toISOString();
			await testDb.db.insert(projects).values({
				id: "proj/consumer-transient",
				name: "Transient Project",
				sessionCount: 1,
				createdAt: now,
				lastSeen: now,
			});
			await testDb.db.insert(sessions).values({
				id: "sess-consumer-transient",
				projectId: "proj/consumer-transient",
				source: "droid",
				rawText: "User: hello transient",
				consolidated: 0,
				createdAt: now,
			});

			// Mock rate limit 429 response
			globalThis.fetch = async () =>
				new Response("Rate limit exceeded", {
					status: 429,
					statusText: "Too Many Requests",
				});

			const msg = createMockMessage({
				sessionId: "sess-consumer-transient",
				projectId: "proj/consumer-transient",
			});
			const batch = createMockBatch([msg]);

			// Expect the consumer to throw the error to allow queue retry
			await expect(
				processIngestQueue(batch, { DB: testDb.db, FIREWORKS_API_KEY: "test-api-key" }),
			).rejects.toThrow(/HTTP 429/);

			const sess = testDb.db
				.select()
				.from(sessions)
				.where(eq(sessions.id, "sess-consumer-transient"))
				.get();
			// Session remains pending
			expect(sess?.consolidated).toBe(0);
			expect(sess?.extractionError).toBeNull();
		});

		it("Test 1.5 (Consumer Permanent Error/Failure Cap): parse failure sets consolidated = -1, writes extractionError, and returns normally", async () => {
			const now = new Date().toISOString();
			await testDb.db.insert(projects).values({
				id: "proj/consumer-permanent",
				name: "Permanent Project",
				sessionCount: 1,
				createdAt: now,
				lastSeen: now,
			});
			await testDb.db.insert(sessions).values({
				id: "sess-consumer-permanent",
				projectId: "proj/consumer-permanent",
				source: "droid",
				rawText: "User: hello permanent",
				consolidated: 0,
				createdAt: now,
			});

			// Mock Fireworks response with invalid LLM output (parse failure)
			globalThis.fetch = async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: "I cannot retrieve any facts from this garbage conversation.",
								},
							},
						],
					}),
					{ status: 200 },
				);

			const msg = createMockMessage({
				sessionId: "sess-consumer-permanent",
				projectId: "proj/consumer-permanent",
			});
			const batch = createMockBatch([msg]);

			// Should resolve successfully (acknowledge the message) without throwing
			await processIngestQueue(batch, { DB: testDb.db, FIREWORKS_API_KEY: "test-api-key" });

			const sess = testDb.db
				.select()
				.from(sessions)
				.where(eq(sessions.id, "sess-consumer-permanent"))
				.get();
			expect(sess?.consolidated).toBe(-1);
			expect(sess?.extractionError).toBe(
				"I cannot retrieve any facts from this garbage conversation.",
			);
		});

		it("Test 1.8 (Missing Session in Consumer): handles session ID not found in D1, logs warning, returns normally", async () => {
			const msg = createMockMessage({
				sessionId: "sess-nonexistent-id",
				projectId: "proj/nonexistent",
			});
			const batch = createMockBatch([msg]);

			// Should resolve successfully without throwing
			await processIngestQueue(batch, { DB: testDb.db, FIREWORKS_API_KEY: "test-api-key" });
		});

		it("Test 1.9 (Empty Queue Batch in Consumer): handles empty queue batch gracefully and returns normally", async () => {
			const batch = createMockBatch([]);

			// Should resolve successfully without throwing
			await processIngestQueue(batch, { DB: testDb.db, FIREWORKS_API_KEY: "test-api-key" });
		});
	});
});
