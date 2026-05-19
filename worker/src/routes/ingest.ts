import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { memories, projects, sessions } from "../schema";

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
): Promise<Extracted | null> {
	if (!apiKey) return { facts: [] };
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
			return null; // signal HTTP failure
		}
		const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		const raw = data.choices?.[0]?.message?.content ?? "";
		return recoverJSON(raw);
	} catch {
		return null; // timeout / network failure
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

/* ───────── helpers: auto-consolidation trigger ───────── */

type DbLike = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, unknown>>;

export function setConsolidationTrigger(fn: (projectId: string, db: DbLike) => void) {
	consolidationTrigger = fn;
}

let consolidationTrigger: (projectId: string, db: DbLike) => void = (
	_projectId: string,
	_db: DbLike,
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

function triggerConsolidation(projectId: string, db: DbLike) {
	consolidationTrigger(projectId, db);
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

		// ── check duplicate session ──
		const existingSession = dbCtx
			.select()
			.from(sessions)
			.where(eq(sessions.id, body.session_id))
			.get();
		if (existingSession) {
			return c.json({ ok: true, facts_written: 0 }, 200);
		}

		// ── upsert project ──
		const existingProject = dbCtx
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.id, body.project_id))
			.get();
		if (existingProject) {
			dbCtx
				.update(projects)
				.set({
					lastSeen: now,
					sessionCount: sql`${projects.sessionCount} + 1`,
				})
				.where(eq(projects.id, body.project_id))
				.run();
		} else {
			dbCtx
				.insert(projects)
				.values({
					id: body.project_id,
					name: body.project_name || body.project_id.split("/").pop() || body.project_id,
					sessionCount: 1,
					createdAt: now,
					lastSeen: now,
				})
				.run();
		}

		// ── insert session ──
		dbCtx
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
			.run();

		// ── extract facts via Firepass ──
		const env = opts?.getEnv ? opts.getEnv(c) : {};
		const fwKey = env.FIREWORKS_API_KEY ?? "";
		const fwModel = env.FIREWORKS_MODEL ?? DEFAULT_FIREWORKS_MODEL;
		let factsWritten = 0;
		let consolidated = 0;
		let extractionError: string | null = null;

		try {
			const extracted = await extractFacts(body.conversation, fwKey, fwModel);
			if (!extracted) {
				// Complete parse failure or HTTP error
				consolidated = -1;
				extractionError = "Firepass extraction failed";
			} else {
				const filtered = filterFacts(extracted.facts);
				if (filtered.length > 0) {
					const { factsToInsert, updates } = await dedupFacts(filtered, body.project_id, dbCtx);
					factsWritten = factsToInsert.length + updates.length;

					// insert new memories
					for (const f of factsToInsert) {
						dbCtx
							.insert(memories)
							.values({
								id: crypto.randomUUID(),
								projectId: body.project_id,
								sourceSession: body.session_id,
								topic: f.topic,
								content: f.content,
								confidence: f.confidence,
								curated: 0,
								status: "active",
								createdAt: now,
								updatedAt: now,
							})
							.run();
					}

					// update dedupped memories
					for (const u of updates) {
						dbCtx
							.update(memories)
							.set({
								updatedAt: now,
								...(u.content !== undefined ? { content: u.content } : {}),
								confidence: u.confidence,
							})
							.where(eq(memories.id, u.id))
							.run();
					}
				}
			}
		} catch (e) {
			consolidated = -1;
			extractionError = e instanceof Error ? e.message : String(e);
		}

		// ── update session with extraction result ──
		dbCtx
			.update(sessions)
			.set({ consolidated, extractionError })
			.where(eq(sessions.id, body.session_id))
			.run();

		// ── auto-consolidation trigger ──
		const unconsol = unconsolidatedCount(body.project_id, dbCtx);
		if (unconsol >= 5) {
			triggerConsolidation(body.project_id, dbCtx);
		}

		return c.json({ ok: true, facts_written: factsWritten }, 200);
	});
}
