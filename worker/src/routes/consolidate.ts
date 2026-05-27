import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db";
import { createDatabaseFromEnv, normalizeWriteResult } from "../db";
import { callFirepass } from "../lib/firepass";
import { PREFERENCES_TOPIC } from "../lib/topics";
import { jaccardSimilarity } from "../lib/utils";
import { GLOBAL_PROJECT_ID, memories, projects, sessions } from "../schema";

/* ───────── types ───────── */

interface Fact {
	topic: string;
	content: string;
	confidence: number;
}

interface Extracted {
	facts: Fact[];
}

import { DEFAULT_FIREWORKS_MODEL } from "../lib/firepass";

/* ───────── constants ───────── */

const MAX_PROMPT_CHARS = 120_000; // hard cap to avoid Worker crash

const CONSOLIDATION_PROMPT = `You are a memory consolidation engine. Read the existing memories and new session conversations below, then produce a clean, consolidated set of facts for this project.

Rules:
- Output ONLY a JSON object: {"facts":[{"topic":"...","content":"...","confidence":0.X}]}
- Confidence >= 0.7 to store it
- Max 15 facts. Prioritize high signal.
- Acceptable topics: project_context, decisions, issues, preferences, general
- Content should be a single declarative sentence.
- Merge duplicates: if two facts say the same thing, keep the best phrased one.
- Remove stale facts that are no longer relevant.
- Do NOT add commentary outside the JSON.

Existing Memories:
{MEMORIES}

New Session Conversations:
{CONVERSATIONS}

Consolidate the above into the most useful, up-to-date set of facts.`;

/* ───────── in-flight guard (per-isolate) ───────── */

const inFlight = new Map<string, boolean>();
const globalInFlight = new Map<string, boolean>();

export function isConsolidationInFlight(projectId: string): boolean {
	return inFlight.get(projectId) ?? false;
}

type ActiveMemoryRow = {
	id: string;
	topic: string | null;
	content: string | null;
	confidence: number;
	curated: number;
	updatedAt: string | null;
};

async function ensureGlobalProjectRow(db: Database, now: string): Promise<void> {
	await db
		.insert(projects)
		.values({
			id: GLOBAL_PROJECT_ID,
			name: "Global",
			sessionCount: 0,
			createdAt: now,
			lastSeen: now,
		})
		.onConflictDoNothing()
		.run();
}

async function acquireGlobalWriteLock(db: Database): Promise<boolean> {
	const lockResult = await db
		.update(projects)
		.set({ consolidationInProgress: 1 })
		.where(and(eq(projects.id, GLOBAL_PROJECT_ID), eq(projects.consolidationInProgress, 0)))
		.run();

	const { changes } = normalizeWriteResult(lockResult);
	return changes !== 0;
}

async function releaseGlobalWriteLock(db: Database): Promise<void> {
	try {
		await db
			.update(projects)
			.set({ consolidationInProgress: 0 })
			.where(eq(projects.id, GLOBAL_PROJECT_ID))
			.run();
	} catch {
		// ignore
	}
}

const GLOBAL_LOCK_MAX_ATTEMPTS = 50;
const GLOBAL_LOCK_RETRY_MS = 20;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchActiveGlobalMemories(db: Database): Promise<ActiveMemoryRow[]> {
	const rows = await db
		.select()
		.from(memories)
		.where(and(eq(memories.projectId, GLOBAL_PROJECT_ID), eq(memories.status, "active")))
		.all();
	return rows.map((row) => ({
		id: row.id,
		topic: row.topic,
		content: row.content,
		confidence: row.confidence ?? 0,
		curated: row.curated ?? 0,
		updatedAt: row.updatedAt,
	}));
}

interface BuildPromptResult {
	prompt: string;
	includedSessionIds: string[];
}

export function buildSafeConsolidationPrompt(
	allSessions: Array<{ id: string; rawText: string | null }>,
	memoryRows: Array<{ topic: string | null; content: string | null }>,
	maxChars = MAX_PROMPT_CHARS,
): BuildPromptResult {
	const memoriesStr =
		memoryRows.map((m) => `- [${m.topic ?? "general"}] ${m.content ?? ""}`).join("\n") || "None";

	const baseTemplate = CONSOLIDATION_PROMPT.replace("{MEMORIES}", memoriesStr).replace(
		"{CONVERSATIONS}",
		"",
	);
	const remainingBudget = maxChars - baseTemplate.length - 100;

	let conversationsStr = "";
	const includedSessionIds: string[] = [];

	for (let i = allSessions.length - 1; i >= 0; i--) {
		const session = allSessions[i];
		if (!session) continue;

		const chunk = `--- Session ---\nID: ${session.id}\n${session.rawText ?? ""}\n\n`;
		// Always include at least the newest session to guarantee consolidation progress
		if (includedSessionIds.length > 0 && conversationsStr.length + chunk.length > remainingBudget) {
			break;
		}
		conversationsStr = chunk + conversationsStr;
		includedSessionIds.push(session.id);
	}

	const finalPrompt = CONSOLIDATION_PROMPT.replace("{MEMORIES}", memoriesStr).replace(
		"{CONVERSATIONS}",
		conversationsStr || "[No unconsolidated conversations fit in budget]",
	);

	return {
		prompt: finalPrompt,
		includedSessionIds,
	};
}

/* ───────── core consolidation ───────── */

export async function runConsolidation(
	projectId: string,
	db: Database,
	env: { FIREWORKS_API_KEY?: string; FIREWORKS_MODEL?: string },
	extractor?: (prompt: string, apiKey: string, model: string) => Promise<Extracted | null>,
	maxChars = MAX_PROMPT_CHARS,
): Promise<{ consolidated: number; archived: number; error?: string }> {
	// Guard 1: prevent concurrent runs in the same isolate
	if (inFlight.get(projectId)) {
		return { consolidated: 0, archived: 0, error: "Consolidation already in progress" };
	}

	let acquiredDbLock = false;
	try {
		// Guard 2: prevent concurrent runs across isolates using atomic SQLite D1 lock
		const lockResult = await db
			.update(projects)
			.set({ consolidationInProgress: 1 })
			.where(and(eq(projects.id, projectId), eq(projects.consolidationInProgress, 0)))
			.run();

		const { changes } = normalizeWriteResult(lockResult);
		if (changes === 0) {
			return { consolidated: 0, archived: 0, error: "Consolidation already in progress" };
		}
		acquiredDbLock = true;
	} catch (_err) {
		// If table schema lacks the column in old installs, proceed to avoid breaking legacy databases
	}

	inFlight.set(projectId, true);

	try {
		const apiKey = env.FIREWORKS_API_KEY ?? "";
		const model = env.FIREWORKS_MODEL || DEFAULT_FIREWORKS_MODEL;
		const now = new Date().toISOString();

		/* 1. Read unconsolidated + error-flagged sessions */
		const pendingRows = await db
			.select()
			.from(sessions)
			.where(and(eq(sessions.projectId, projectId), eq(sessions.consolidated, 0)))
			.all();

		const errorRows = await db
			.select()
			.from(sessions)
			.where(and(eq(sessions.projectId, projectId), eq(sessions.consolidated, -1)))
			.all();

		const allSessions = [...pendingRows, ...errorRows];

		if (allSessions.length === 0) {
			return { consolidated: 0, archived: 0 };
		}

		/* 2. Read existing active memories (exclude archived) */
		const existingMemories = await db
			.select()
			.from(memories)
			.where(and(eq(memories.projectId, projectId), eq(memories.status, "active")))
			.all();

		/* 3. Build prompt */
		const { prompt, includedSessionIds } = buildSafeConsolidationPrompt(
			allSessions,
			existingMemories.map((m) => ({ topic: m.topic, content: m.content })),
			maxChars,
		);

		/* 4. Call Firepass */
		const firepassResult = extractor
			? { extracted: await extractor(prompt, apiKey, model), rawResponse: null, error: undefined }
			: await callFirepass(prompt, apiKey, model);
		const extracted = firepassResult.extracted;

		if (!extracted) {
			const detail = firepassResult.error ?? "unknown";
			return { consolidated: 0, archived: 0, error: `Firepass consolidation failed (${detail})` };
		}

		/* 5. Dedup and merge consolidated facts, then mark sessions (all atomic) */

		const mayTouchGlobal = extracted.facts.some(
			(f) => f.confidence >= 0.7 && f.topic === PREFERENCES_TOPIC,
		);

		const applyConsolidationWrites = async (existingGlobalMemories: ActiveMemoryRow[]) => {
			await db.atomic(async (collect) => {
				// Ensure global project row exists
				collect(
					db
						.insert(projects)
						.values({
							id: GLOBAL_PROJECT_ID,
							name: "Global",
							sessionCount: 0,
							createdAt: now,
							lastSeen: now,
						})
						.onConflictDoNothing(),
				);

				const localFactsToInsert: Fact[] = [];
				const localUpdates: Array<{ id: string; content?: string; confidence: number }> = [];
				const globalFactsToInsert: Fact[] = [];
				const globalUpdates: Array<{ id: string; content?: string; confidence: number }> = [];

				for (const fact of extracted.facts.filter((f) => f.confidence >= 0.7)) {
					const isGlobal = fact.topic === PREFERENCES_TOPIC;
					const existingMems = isGlobal ? existingGlobalMemories : existingMemories;

					let matched = false;
					for (const mem of existingMems) {
						if (jaccardSimilarity(fact.content, mem.content ?? "") > 0.6) {
							matched = true;
							if (mem.curated === 1) {
								// Corroboration refresh: update curated fact's updated_at (in-batch call)
								collect(db.update(memories).set({ updatedAt: now }).where(eq(memories.id, mem.id)));
								break;
							}
							const memConfidence = mem.confidence ?? 0;
							const nextConfidence =
								fact.confidence > memConfidence ? fact.confidence : memConfidence;
							const updateEntry: {
								id: string;
								content?: string;
								confidence: number;
							} = {
								id: mem.id,
								...(fact.confidence > memConfidence ? { content: fact.content } : {}),
								confidence: nextConfidence,
							};
							if (isGlobal) {
								globalUpdates.push(updateEntry);
							} else {
								localUpdates.push(updateEntry);
							}
							break;
						}
					}
					if (!matched) {
						if (isGlobal) {
							globalFactsToInsert.push(fact);
						} else {
							localFactsToInsert.push(fact);
						}
					}
				}

				for (const u of localUpdates) {
					collect(
						db
							.update(memories)
							.set({
								updatedAt: now,
								consolidated: 1,
								...(u.content !== undefined ? { content: u.content } : {}),
								confidence: u.confidence,
							})
							.where(eq(memories.id, u.id)),
					);
				}

				for (const f of localFactsToInsert) {
					collect(
						db.insert(memories).values({
							id: crypto.randomUUID(),
							projectId,
							sourceSession: includedSessionIds[0] ?? crypto.randomUUID(),
							topic: f.topic,
							content: f.content,
							confidence: f.confidence,
							curated: 0,
							consolidated: 1,
							status: "active",
							createdAt: now,
							updatedAt: now,
						}),
					);
				}

				// Delete old draft memories for this project (curated=0, consolidated=0)
				collect(
					db
						.delete(memories)
						.where(
							and(
								eq(memories.projectId, projectId),
								eq(memories.curated, 0),
								eq(memories.consolidated, 0),
							),
						),
				);

				for (const u of globalUpdates) {
					collect(
						db
							.update(memories)
							.set({
								updatedAt: now,
								consolidated: 1,
								...(u.content !== undefined ? { content: u.content } : {}),
								confidence: u.confidence,
							})
							.where(eq(memories.id, u.id)),
					);
				}

				for (const f of globalFactsToInsert) {
					collect(
						db.insert(memories).values({
							id: crypto.randomUUID(),
							projectId: GLOBAL_PROJECT_ID,
							sourceSession: includedSessionIds[0] ?? crypto.randomUUID(),
							topic: f.topic,
							content: f.content,
							confidence: f.confidence,
							curated: 0,
							consolidated: 1,
							status: "active",
							createdAt: now,
							updatedAt: now,
						}),
					);
				}

				// Only delete global drafts when this pass legitimately touched global
				if (mayTouchGlobal) {
					collect(
						db
							.delete(memories)
							.where(
								and(
									eq(memories.projectId, GLOBAL_PROJECT_ID),
									eq(memories.curated, 0),
									eq(memories.consolidated, 0),
								),
							),
					);
				}

				for (const s of allSessions) {
					if (includedSessionIds.includes(s.id)) {
						collect(
							db
								.update(sessions)
								.set({ consolidated: 1, rawText: null, extractionError: null })
								.where(eq(sessions.id, s.id)),
						);
					}
				}
			});
		};

		if (mayTouchGlobal) {
			await ensureGlobalProjectRow(db, now);

			let acquiredGlobalDbLock = false;
			for (let attempt = 0; attempt < GLOBAL_LOCK_MAX_ATTEMPTS; attempt++) {
				while (globalInFlight.get(GLOBAL_PROJECT_ID)) {
					await sleep(GLOBAL_LOCK_RETRY_MS);
				}
				try {
					acquiredGlobalDbLock = await acquireGlobalWriteLock(db);
				} catch {
					// Legacy schema without consolidation_in_progress — proceed without DB lock
					acquiredGlobalDbLock = true;
					break;
				}
				if (acquiredGlobalDbLock) break;
				await sleep(GLOBAL_LOCK_RETRY_MS);
			}

			if (!acquiredGlobalDbLock) {
				try {
					const locked = await db
						.select({ consolidationInProgress: projects.consolidationInProgress })
						.from(projects)
						.where(eq(projects.id, GLOBAL_PROJECT_ID))
						.get();
					if ((locked?.consolidationInProgress ?? 0) === 1) {
						return {
							consolidated: 0,
							archived: 0,
							error: "Global memory write already in progress",
						};
					}
					return {
						consolidated: 0,
						archived: 0,
						error: "Global memory lock not acquired",
					};
				} catch {
					// Legacy schema without consolidation_in_progress — proceed without DB lock
					acquiredGlobalDbLock = true;
				}
			}

			globalInFlight.set(GLOBAL_PROJECT_ID, true);
			try {
				const existingGlobalMemories = await fetchActiveGlobalMemories(db);
				await applyConsolidationWrites(existingGlobalMemories);
			} finally {
				globalInFlight.delete(GLOBAL_PROJECT_ID);
				if (acquiredGlobalDbLock) {
					await releaseGlobalWriteLock(db);
				}
			}
		} else {
			await applyConsolidationWrites([]);
		}

		return { consolidated: includedSessionIds.length, archived: 0 };
	} finally {
		inFlight.delete(projectId);
		if (acquiredDbLock) {
			try {
				await db
					.update(projects)
					.set({ consolidationInProgress: 0 })
					.where(eq(projects.id, projectId))
					.run();
			} catch {
				// ignore
			}
		}
	}
}

/* ───────── Cron: consolidate all projects with >=2 unconsolidated sessions ───────── */

export async function runCronConsolidation(
	db: Database,
	env: { FIREWORKS_API_KEY?: string; FIREWORKS_MODEL?: string },
	extractor?: (prompt: string, apiKey: string, model: string) => Promise<Extracted | null>,
): Promise<{ projectsProcessed: number; totalSessions: number; totalArchived: number }> {
	let projectsProcessed = 0;
	let totalSessions = 0;
	let totalArchived = 0;

	// Query projects with >=2 unconsolidated sessions, skipping the global pseudo-project.
	// Global memories are managed via routing, promotion dedup, and manual /memories curation,
	// not through project-level cron consolidation.
	const rows = await db
		.select({ projectId: sessions.projectId })
		.from(sessions)
		.where(and(eq(sessions.consolidated, 0), ne(sessions.projectId, GLOBAL_PROJECT_ID)))
		.groupBy(sessions.projectId)
		.having(sql`count(*) >= 2`)
		.all();

	for (const row of rows) {
		const result = await runConsolidation(row.projectId, db, env, extractor);
		if (!result.error) {
			projectsProcessed++;
			totalSessions += result.consolidated;
			totalArchived += result.archived;
		}
	}

	return { projectsProcessed, totalSessions, totalArchived };
}

/* ───────── route ───────── */

function getDb(c: { env: { DB: D1Database } }) {
	return createDatabaseFromEnv(c.env.DB);
}

export function createConsolidateRoute(
	// biome-ignore lint/suspicious/noExplicitAny: Hono generic typing too restrictive for route wrappers
	app: any,
	db?: Database,
	opts?: {
		// biome-ignore lint/suspicious/noExplicitAny: env bindings vary across Workers runtimes
		getEnv?: (c: any) => { FIREWORKS_API_KEY?: string; FIREWORKS_MODEL?: string };
		extractor?: (prompt: string, apiKey: string, model: string) => Promise<Extracted | null>;
	},
) {
	// biome-ignore lint/suspicious/noExplicitAny: Hono context types are runtime-specific
	app.post("/consolidate", async (c: any) => {
		const dbCtx = db || (await getDb(c));

		let body: { project_id?: string };
		try {
			body = (await c.req.json()) as { project_id?: string };
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const projectId = body.project_id;
		if (!projectId || typeof projectId !== "string" || projectId.trim() === "") {
			return c.json({ error: "Missing or invalid field: project_id" }, 400);
		}

		const env = opts?.getEnv
			? opts.getEnv(c)
			: {
					FIREWORKS_API_KEY: (c.env as Record<string, string>).FIREWORKS_API_KEY ?? "",
					FIREWORKS_MODEL: (c.env as Record<string, string>).FIREWORKS_MODEL ?? "",
				};

		const result = await runConsolidation(projectId, dbCtx, env, opts?.extractor);

		if (result.error) {
			if (result.error === "Consolidation already in progress") {
				return c.json({ ok: true, message: result.error }, 409);
			}
			return c.json(
				{
					ok: true,
					message: result.error,
					consolidated: result.consolidated,
					archived: result.archived,
				},
				200,
			);
		}

		if (result.consolidated === 0 && result.archived === 0) {
			return c.json(
				{ ok: true, message: "Nothing to consolidate", consolidated: 0, archived: 0 },
				200,
			);
		}

		return c.json({ ok: true, consolidated: result.consolidated, archived: result.archived }, 200);
	});
}
