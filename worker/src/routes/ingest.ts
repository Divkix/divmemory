import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { memories, projects, sessions } from "../schema";

/* ───────── types ───────── */

export type DbLike = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, unknown>>;

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

/* ───────── helpers: JSON recovery ───────── */

export function recoverJSON(raw: string): Extracted | null {
	if (!raw) return null;

	// Stage 1: strip markdown fences and try clean JSON.parse
	const trimmed = raw.replace(/^```json\s*/im, "").replace(/\s*```$/im, "");
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (isExtracted(parsed)) return parsed;
	} catch {
		/* continue */
	}

	// Stage 2: extract valid `{ ... }` objects from the raw text
	const objects: unknown[] = [];
	const re = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: safe loop
	while ((m = re.exec(raw)) !== null) {
		try {
			const v = JSON.parse(m[0]) as unknown;
			objects.push(v);
		} catch {
			/* skip malformed */
		}
	}

	// Try wrapping objects into a facts array
	if (objects.length > 0) {
		return { facts: objects.filter(isFact) };
	}

	return null;
}

function isFact(v: unknown): v is Fact {
	if (!v || typeof v !== "object") return false;
	const f = v as Record<string, unknown>;
	return (
		typeof f.topic === "string" && typeof f.content === "string" && typeof f.confidence === "number"
	);
}

function isExtracted(v: unknown): v is Extracted {
	if (!v || typeof v !== "object") return false;
	const e = v as Record<string, unknown>;
	return Array.isArray(e.facts) && e.facts.every(isFact);
}

/* ───────── helpers: Jaccard similarity (token overlap) ───────── */

function tokenize(text: string): Set<string> {
	const words = text
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ") // keep CJK chars
		.split(/\s+/)
		.filter((w) => w.length > 0);
	return new Set(words);
}

export function jaccardSimilarity(a: string, b: string): number {
	if (!a.trim() || !b.trim()) return 0;
	const sa = tokenize(a);
	const sb = tokenize(b);
	if (sa.size === 0 || sb.size === 0) return 0;
	let intersection = 0;
	for (const w of sa) {
		if (sb.has(w)) intersection++;
	}
	const union = sa.size + sb.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/* ───────── Firepass extraction ───────── */

const DEFAULT_FIREWORKS_MODEL = "accounts/fireworks/routers/kimi-k2p6-turbo";
const FIREPASS_TIMEOUT = 30000; // 30s

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

export async function extractFacts(
	rawText: string,
	apiKey: string,
	model = DEFAULT_FIREWORKS_MODEL,
): Promise<ExtractionResult> {
	if (!apiKey) {
		return { extracted: { facts: [] }, rawResponse: null };
	}
	const prompt = EXTRACTION_PROMPT.replace("{CONVERSATION}", rawText.slice(0, 100_000)); // truncate if huge
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FIREPASS_TIMEOUT);
		const res = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0.1,
				max_tokens: 4096,
			}),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) {
			const bodyText = await res.text();
			return {
				extracted: null,
				rawResponse: bodyText,
				error: `HTTP ${res.status}: ${res.statusText}`,
			};
		}
		const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		const raw = data.choices?.[0]?.message?.content ?? "";
		const extracted = recoverJSON(raw);
		return { extracted, rawResponse: raw };
	} catch (err) {
		return {
			extracted: null,
			rawResponse: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
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
	const existing = db
		.select()
		.from(memories)
		.where(and(eq(memories.projectId, projectId), eq(memories.status, "active")))
		.all() as Array<{
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

/* ───────── atomic DB writes helper ───────── */

// D1: uses db.batch() for true atomicity (D1 auto-commit ignores raw BEGIN/COMMIT)
// bun-sqlite: uses db.transaction() via Drizzle's SQLite transaction API
async function runAtomic<T>(
	db: DbLike,
	fn: (dbOrTx: DbLike, addStmt: (q: { run: () => unknown }) => void) => Promise<T>,
): Promise<T> {
	// Detect D1 by presence of .batch() method
	if ("batch" in db && typeof (db as unknown as { batch: unknown }).batch === "function") {
		const stmts: Array<{ run: () => unknown }> = [];
		const addStmt = (q: { run: () => unknown }) => stmts.push(q);
		const result = await fn(db, addStmt);
		if (stmts.length > 0) {
			await (db as unknown as { batch: (batch: unknown[]) => Promise<unknown[]> }).batch(stmts);
		}
		return result;
	}
	// bun-sqlite: execute in Drizzle transaction; addStmt calls .run() immediately
	return (
		db as unknown as { transaction: <U>(fn: (tx: DbLike) => Promise<U>) => Promise<U> }
	).transaction(async (tx) => {
		const addStmt = (q: { run: () => unknown }) => {
			q.run();
		};
		return await fn(tx, addStmt);
	});
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

function unconsolidatedCount(projectId: string, db: DbLike): number {
	const row = db
		.select({ count: sql<number>`count(*)` })
		.from(sessions)
		.where(and(eq(sessions.projectId, projectId), eq(sessions.consolidated, 0)))
		.get() as { count: number } | undefined;
	return row?.count ?? 0;
}

function triggerConsolidation(projectId: string, db: DbLike, c: unknown) {
	consolidationTrigger(projectId, db, c);
}

/* ───────── atomic extraction result processor ───────── */

async function processExtractionResult(
	db: DbLike,
	body: IngestBody,
	result: ExtractionResult,
	now: string,
): Promise<number> {
	const projectId = body.project_id;
	const sessionId = body.session_id;

	let factsWritten = 0;

	// If extraction failed entirely, we still need to update session status
	const isExtractionError = result.error || !result.extracted;

	await runAtomic(db, async (tx, addStmt) => {
		/* 1. Upsert project */
		const existingProject = tx
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.id, projectId))
			.get();

		if (existingProject) {
			addStmt(
				tx
					.update(projects)
					.set({
						lastSeen: now,
						sessionCount: sql`${projects.sessionCount} + 1`,
					})
					.where(eq(projects.id, projectId)),
			);
		} else {
			addStmt(
				tx.insert(projects).values({
					id: projectId,
					name: body.project_name || projectId.split("/").pop() || projectId,
					sessionCount: 1,
					createdAt: now,
					lastSeen: now,
				}),
			);
		}

		/* 2. Insert session */
		addStmt(
			tx.insert(sessions).values({
				id: sessionId,
				projectId,
				source: body.source || "droid",
				rawText: body.conversation,
				consolidated: 0,
				extractionError: null,
				tokenCount: body.conversation.length,
				metadata: body.metadata ? JSON.stringify(body.metadata) : null,
				createdAt: now,
			}),
		);

		/* 3. Extract facts + dedup + persist memories */
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

		// ── check duplicate session (read-only, outside transaction) ──
		const existingSession = dbCtx
			.select()
			.from(sessions)
			.where(eq(sessions.id, body.session_id))
			.get();
		if (existingSession) {
			return c.json({ ok: true, facts_written: 0 }, 200);
		}

		// ── unified atomic transaction: project upsert + session insert + fact extraction + persist ──
		const env = opts?.getEnv ? opts.getEnv(c) : {};
		const fwKey = env.FIREWORKS_API_KEY ?? "";
		const fwModel = env.FIREWORKS_MODEL ?? DEFAULT_FIREWORKS_MODEL;

		const doIngest = async () => {
			try {
				// Extraction happens OUTSIDE the DB transaction (network call cannot be rolled back)
				const result = await extractFacts(body.conversation, fwKey, fwModel);
				// All DB writes are a single atomic batch / tx
				const factsWritten = await processExtractionResult(dbCtx, body, result, now);

				// ── auto-consolidation trigger (outside atomic tx) ──
				const unconsol = unconsolidatedCount(body.project_id, dbCtx);
				if (unconsol >= 5) {
					triggerConsolidation(body.project_id, dbCtx, c);
				}
				return factsWritten;
			} catch (e) {
				const errMsg = e instanceof Error ? e.message : String(e);
				// Update session as error (this is itself a single atomic batch for D1)
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
			} else {
				await doIngest();
			}
		} catch {
			await doIngest();
		}

		return c.json({ ok: true, facts_written: 0 }, 200);
	});
}
