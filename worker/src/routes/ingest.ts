import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DbLike } from "../lib/db";
import { runAtomic } from "../lib/db";
import { jaccardSimilarity } from "../lib/utils";
import { memories, projects, sessions } from "../schema";

export type { DbLike } from "../lib/db";
export { jaccardSimilarity, recoverJSON } from "../lib/utils";

/* ───────── types ───────── */

export interface IngestBody {
	session_id: string;
	project_id: string;
	project_name?: string;
	source: string;
	conversation: string;
	metadata?: unknown;
}

interface Fact {
	topic: string;
	content: string;
	confidence: number;
}

interface Extracted {
	facts: Fact[];
}

export interface ExtractionResult {
	extracted: Extracted | null;
	rawResponse: string | null;
	error?: string;
}

import { callFirepass, DEFAULT_FIREWORKS_MODEL, type FirepassResult } from "../lib/firepass";

/* ───────── Firepass extraction ───────── */

const EXTRACTION_PROMPT = `You are a memory-extraction engine. Read the conversation below and extract concrete facts worth remembering across sessions (project context, decisions, issues, preferences, or general helpful info).

Rules:
- Output ONLY a JSON object: {"facts":[{"topic":"...","content":"...","confidence":0.X}]}
- Confidence >= 0.7 to store it
- Max 15 facts per session. Prioritize high signal.
- Acceptable topics: project_context, decisions, issues, preferences, general
- Content should be a single declarative sentence.
- Do NOT add commentary outside the JSON.

Conversation:
---CONVERSATION_START---
{CONVERSATION}
---CONVERSATION_END---`;

/**
 * Safely slices a conversation string from the end to fit within a char limit,
 * ensuring it starts cleanly at a turn boundary ("User:" or "Assistant:").
 */
export function truncateConversationFromEnd(text: string, maxChars = 100_000): string {
	if (text.length <= maxChars) return text;

	// Take the raw slice from the end
	let sliced = text.slice(-maxChars);

	// Find the first occurrence of a turn header near the beginning of the slice.
	// Anchor to turn boundaries by searching for newline-prefixed headers so
	// substrings inside message content (e.g. code blocks) are not treated
	// as actual boundaries.
	const firstUser = sliced.indexOf("\nUser:");
	const firstAssistant = sliced.indexOf("\nAssistant:");

	let splitIdx = -1;
	if (firstUser !== -1 && firstAssistant !== -1) {
		splitIdx = Math.min(firstUser, firstAssistant) + 1;
	} else if (firstUser !== -1) {
		splitIdx = firstUser + 1;
	} else if (firstAssistant !== -1) {
		splitIdx = firstAssistant + 1;
	}

	if (splitIdx !== -1) {
		sliced = sliced.slice(splitIdx);
	}

	return `[Conversation truncated for length...]\n\n${sliced}`;
}

export async function extractFacts(
	rawText: string,
	apiKey: string,
	model = "accounts/fireworks/routers/kimi-k2p6-turbo",
): Promise<ExtractionResult> {
	const prompt = EXTRACTION_PROMPT.replace("{CONVERSATION}", truncateConversationFromEnd(rawText));
	const result: FirepassResult = await callFirepass(prompt, apiKey, model);
	return result as ExtractionResult;
}

/* ───────── helpers: fact processing ───────── */

const CONFIDENCE_THRESHOLD = 0.7;
const MAX_FACTS_PER_SESSION = 15;
const DEDUP_THRESHOLD = 0.6;
const MAX_CONTENT_LEN = 10000;

function filterFacts(facts: Fact[]): Fact[] {
	return facts
		.filter((f) => f.confidence >= CONFIDENCE_THRESHOLD)
		.slice(0, MAX_FACTS_PER_SESSION)
		.filter((f) => f.content.length <= MAX_CONTENT_LEN);
}

/**
 * For each new fact, look for an existing memory in the same project with
 * jaccard > threshold.  If found:
 *   - curated=1  → skip entirely (don't touch)
 *   - new.confidence > old.confidence  → replace content, update timestamp
 *   - otherwise  → just update updated_at timestamp
 *
 * Returns { factsToInsert: Fact[], factsToUpdate: Array<{id:string, content?:string, confidence?:number} }
 */
async function dedupFacts(
	facts: Fact[],
	projectId: string,
	db: DbLike,
): Promise<{
	factsToInsert: Fact[];
	updates: Array<{ id: string; content?: string; confidence: number }>;
}> {
	const existing = (await db
		.select()
		.from(memories)
		.where(and(eq(memories.projectId, projectId), eq(memories.status, "active")))
		.all()) as Array<{
		id: string;
		content: string;
		confidence: number;
		curated: number;
	}>;

	const factsToInsert: Fact[] = [];
	const updates: Array<{ id: string; content?: string; confidence: number }> = [];

	for (const fact of facts) {
		let matched = false;
		for (const mem of existing) {
			if (jaccardSimilarity(fact.content, mem.content) > DEDUP_THRESHOLD) {
				matched = true;
				if (mem.curated === 1) {
					// curated fact protection: skip entirely
					break;
				}
				if (fact.confidence > mem.confidence) {
					updates.push({
						id: mem.id,
						content: fact.content,
						confidence: fact.confidence,
					});
				} else {
					updates.push({
						id: mem.id,
						confidence: mem.confidence, // keep old confidence, still need to update timestamp
					});
				}
				break;
			}
		}
		if (!matched) {
			factsToInsert.push(fact);
		}
	}

	return { factsToInsert, updates };
}

/* ───────── helpers: auto-consolidation trigger ───────── */

export function setConsolidationTrigger(
	fn: (projectId: string, db: DbLike, c: unknown) => void | Promise<void>,
) {
	consolidationTrigger = fn;
}

let consolidationTrigger: (projectId: string, db: DbLike, c: unknown) => void | Promise<void> = (
	_projectId: string,
	_db: DbLike,
	_c: unknown,
) => {
	// default no-op — real trigger wired by the consolidation feature
};

async function unconsolidatedCount(projectId: string, db: DbLike): Promise<number> {
	const row = (await db
		.select({ count: sql<number>`count(*)` })
		.from(sessions)
		.where(and(eq(sessions.projectId, projectId), eq(sessions.consolidated, 0)))
		.get()) as { count: number } | undefined;
	return row?.count ?? 0;
}

function triggerConsolidation(projectId: string, db: DbLike, c: unknown) {
	consolidationTrigger(projectId, db, c);
}

/* ───────── split atomic DB operations: pre-insert (session with raw_text) + post-extraction update ───────── */

async function ensureProjectExists(db: DbLike, body: IngestBody, now: string): Promise<void> {
	// Creates the project row if missing (for FK compliance). Does NOT
	// increment sessionCount — that only happens after the session is
	// confirmed as newly created (not a duplicate).
	const projectId = body.project_id;
	const existingProject = await db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.get();
	if (!existingProject) {
		await db.insert(projects).values({
			id: projectId,
			name: body.project_name || projectId.split("/").pop() || projectId,
			sessionCount: 0, // will be incremented when the session is actually inserted
			createdAt: now,
			lastSeen: now,
		});
	}
}

async function incrementProjectSessionCount(db: DbLike, body: IngestBody, now: string): Promise<void> {
	// Increments sessionCount and updates lastSeen for an existing project.
	// Only called AFTER the session insert confirmed this is a new session.
	const projectId = body.project_id;
	await runAtomic(db, async (tx, addStmt) => {
		addStmt(
			tx
				.update(projects)
				.set({
					lastSeen: now,
					sessionCount: sql`${projects.sessionCount} + 1`,
				})
				.where(eq(projects.id, projectId)),
		);
	});
}

async function processExtractionAfter(
	db: DbLike,
	body: IngestBody,
	result: ExtractionResult,
	now: string,
): Promise<number> {
	const projectId = body.project_id;
	const sessionId = body.session_id;

	let factsWritten = 0;
	const isExtractionError = result.error || !result.extracted;

	await runAtomic(db, async (tx, addStmt) => {
		if (isExtractionError) {
			const rawResponse = result.rawResponse ?? result.error ?? "Firepass extraction failed";
			addStmt(
				tx
					.update(sessions)
					.set({ consolidated: -1, extractionError: rawResponse })
					.where(eq(sessions.id, sessionId)),
			);
		} else {
			// biome-ignore lint/style/noNonNullAssertion: guarded by isExtractionError check above
			const filtered = filterFacts(result.extracted!.facts);
			if (filtered.length > 0) {
				const { factsToInsert, updates } = await dedupFacts(filtered, projectId, tx);
				factsWritten = factsToInsert.length + updates.length;

				for (const f of factsToInsert) {
					addStmt(
						tx.insert(memories).values({
							id: crypto.randomUUID(),
							projectId,
							sourceSession: sessionId,
							topic: f.topic,
							content: f.content,
							confidence: f.confidence,
							curated: 0,
							status: "active",
							createdAt: now,
							updatedAt: now,
						}),
					);
				}

				for (const u of updates) {
					addStmt(
						tx
							.update(memories)
							.set({
								updatedAt: now,
								...(u.content !== undefined ? { content: u.content } : {}),
								confidence: u.confidence,
							})
							.where(eq(memories.id, u.id)),
					);
				}
			}

			addStmt(
				tx
					.update(sessions)
					.set({ consolidated: 0, extractionError: null })
					.where(eq(sessions.id, sessionId)),
			);
		}
	});

	return factsWritten;
}

/* ───────── route ───────── */

/* type for the D1 binding held in Hono context */
function getDb(c: { env: { DB: D1Database } }) {
	return drizzle(c.env.DB);
}

export function createIngestRoute(
	// biome-ignore lint/suspicious/noExplicitAny: Hono generic typing is too restrictive for our use case
	app: any,
	db: DbLike | undefined,
	// biome-ignore lint/suspicious/noExplicitAny: env bindings vary across Workers runtimes
	opts?: { getEnv?: (c: any) => { FIREWORKS_API_KEY?: string; FIREWORKS_MODEL?: string } },
) {
	// biome-ignore lint/suspicious/noExplicitAny: Hono context types are runtime-specific
	app.post("/ingest", async (c: any) => {
		const dbCtx = db || getDb(c);
		let body: IngestBody;
		try {
			body = (await c.req.json()) as IngestBody;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		// ── validation ──
		if (!body.session_id || typeof body.session_id !== "string" || body.session_id.trim() === "") {
			return c.json({ error: "Missing or invalid field: session_id" }, 400);
		}
		if (!body.project_id || typeof body.project_id !== "string" || body.project_id.trim() === "") {
			return c.json({ error: "Missing or invalid field: project_id" }, 400);
		}
		if (typeof body.conversation !== "string") {
			return c.json({ error: "Missing or invalid field: conversation" }, 400);
		}

		const now = new Date().toISOString();

		// ── ensure project exists for FK compliance (no sessionCount bump yet) ──
		await ensureProjectExists(dbCtx, body, now);

		// ── atomic session creation with duplicate detection ──
		// INSERT with ON CONFLICT DO NOTHING is atomic at the SQL level, so
		// concurrent requests for the same session_id cannot both win.
		const created = await dbCtx
			.insert(sessions)
			.values({
				id: body.session_id,
				projectId: body.project_id,
				source: body.source || "droid",
				rawText: body.conversation,
				consolidated: 0,
				extractionError: null,
				tokenCount: body.conversation.length,
				metadata: body.metadata ? JSON.stringify(body.metadata) : null,
				createdAt: now,
			})
			.onConflictDoNothing()
			.returning({ id: sessions.id })
			.get();
		if (!created) {
			return c.json(
				{ ok: true, status: "duplicate", session_id: body.session_id, facts_written: 0 },
				200,
			);
		}

		// ── unified atomic transaction: fact extraction + persist ──
		const env = opts?.getEnv ? opts.getEnv(c) : {};
		const fwKey = env.FIREWORKS_API_KEY ?? "";
		const fwModel = env.FIREWORKS_MODEL ?? DEFAULT_FIREWORKS_MODEL;

		const doIngest = async () => {
			try {
				// Step 1: Bump project session count (only after new session confirmed)
				await incrementProjectSessionCount(dbCtx, body, now);

				// Step 2: Firepass extraction (network call, outside DB transaction)
				const result = await extractFacts(body.conversation, fwKey, fwModel);

				// Step 3: Update session with extraction results (atomic batch / tx)
				const factsWritten = await processExtractionAfter(dbCtx, body, result, now);

				// ── auto-consolidation trigger (outside atomic tx) ──
				const unconsol = await unconsolidatedCount(body.project_id, dbCtx);
				if (unconsol >= 5) {
					triggerConsolidation(body.project_id, dbCtx, c);
				}
				return factsWritten;
			} catch (e) {
				const errMsg = e instanceof Error ? e.message : String(e);
				// Update session as error (atomic batch for D1)
				await runAtomic(dbCtx, async (tx, addStmt) => {
					addStmt(
						tx
							.update(sessions)
							.set({ consolidated: -1, extractionError: errMsg })
							.where(eq(sessions.id, body.session_id)),
					);
				});
				return 0;
			}
		};

		// Production: ctx.executionCtx.waitUntil (non-blocking). Tests: await directly.
		try {
			const wc = c.executionCtx as { waitUntil?: (p: Promise<unknown>) => void };
			if (typeof wc.waitUntil === "function") {
				wc.waitUntil(doIngest());
				return c.json(
					{ ok: true, status: "queued", session_id: body.session_id, facts_written: 0 },
					200,
				);
			} else {
				const factsWritten = await doIngest();
				return c.json(
					{
						ok: true,
						status: "processed",
						session_id: body.session_id,
						facts_written: factsWritten,
					},
					200,
				);
			}
		} catch {
			const factsWritten = await doIngest();
			return c.json(
				{
					ok: true,
					status: "processed",
					session_id: body.session_id,
					facts_written: factsWritten,
				},
				200,
			);
		}
	});
}
