import { and, eq, sql } from "drizzle-orm";
import { memories, sessions } from "../schema";
import type { DbLike } from "./ingest";
import { jaccardSimilarity, recoverJSON } from "./ingest";

/* ───────── types ───────── */

interface Fact {
	topic: string;
	content: string;
	confidence: number;
}

interface Extracted {
	facts: Fact[];
}

/* ───────── constants ───────── */

const DEFAULT_FIREWORKS_MODEL = "accounts/fireworks/routers/kimi-k2p6-turbo";
const FIREPASS_TIMEOUT = 30000; // 30s
const STALE_DAYS = 90;
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

export function isConsolidationInFlight(projectId: string): boolean {
	return inFlight.get(projectId) ?? false;
}

/* ───────── Firepass helper ───────── */

async function callFirepass(
	prompt: string,
	apiKey: string,
	model: string,
): Promise<Extracted | null> {
	if (!apiKey) return null;
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
				messages: [{ role: "user", content: prompt.slice(0, MAX_PROMPT_CHARS) }],
				temperature: 0.1,
				max_tokens: 4096,
			}),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) return null;
		const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		const raw = data.choices?.[0]?.message?.content ?? "";
		return recoverJSON(raw);
	} catch {
		return null;
	}
}

function buildConsolidationPrompt(
	sessionRows: Array<{ rawText: string | null }>,
	memoryRows: Array<{ topic: string | null; content: string | null }>,
): string {
	const memoriesStr =
		memoryRows.map((m) => `- [${m.topic ?? "general"}] ${m.content ?? ""}`).join("\n") || "None";
	const convosStr = sessionRows
		.map((s, i) => `--- Session ${i + 1} ---\n${s.rawText ?? ""}`)
		.join("\n\n");

	const prompt = CONSOLIDATION_PROMPT.replace("{MEMORIES}", memoriesStr).replace(
		"{CONVERSATIONS}",
		convosStr,
	);

	if (prompt.length > MAX_PROMPT_CHARS) {
		/* Truncate oldest sessions first, keep all memories */
		const memoriesPart = CONSOLIDATION_PROMPT.replace("{MEMORIES}", memoriesStr).replace(
			"{CONVERSATIONS}",
			"",
		);
		const remaining = MAX_PROMPT_CHARS - memoriesPart.length - 50;
		let truncated = "";
		for (let i = sessionRows.length - 1; i >= 0; i--) {
			const chunk = `--- Session ${i + 1} ---\n${sessionRows[i]?.rawText ?? ""}\n\n`;
			if (truncated.length + chunk.length > remaining) break;
			truncated = chunk + truncated;
		}
		return CONSOLIDATION_PROMPT.replace("{MEMORIES}", memoriesStr).replace(
			"{CONVERSATIONS}",
			truncated || "[truncated]",
		);
	}
	return prompt;
}

/* ───────── core consolidation ───────── */

export async function runConsolidation(
	projectId: string,
	db: DbLike,
	env: { FIREWORKS_API_KEY?: string; FIREWORKS_MODEL?: string },
	extractor?: (prompt: string, apiKey: string, model: string) => Promise<Extracted | null>,
): Promise<{ consolidated: number; archived: number; error?: string }> {
	// Guard: prevent concurrent runs for same project
	if (inFlight.get(projectId)) {
		return { consolidated: 0, archived: 0, error: "Consolidation already in progress" };
	}

	inFlight.set(projectId, true);

	try {
		const apiKey = env.FIREWORKS_API_KEY ?? "";
		const model = env.FIREWORKS_MODEL ?? DEFAULT_FIREWORKS_MODEL;
		const now = new Date().toISOString();
		const staleThreshold = new Date(Date.now() - STALE_DAYS * 86_400 * 1000).toISOString();

		/* 1. Read unconsolidated + error-flagged sessions */
		const pendingRows = (await db
			.select()
			.from(sessions)
			.where(and(eq(sessions.projectId, projectId), eq(sessions.consolidated, 0)))
			.all()) as Array<{
			id: string;
			rawText: string | null;
			consolidated: number;
			extractionError: string | null;
		}>;

		const errorRows = (await db
			.select()
			.from(sessions)
			.where(and(eq(sessions.projectId, projectId), eq(sessions.consolidated, -1)))
			.all()) as Array<{
			id: string;
			rawText: string | null;
			consolidated: number;
			extractionError: string | null;
		}>;

		const allSessions = [...pendingRows, ...errorRows];

		if (allSessions.length === 0) {
			return { consolidated: 0, archived: 0 };
		}

		/* 2. Read existing active memories (exclude archived) */
		const existingMemories = (await db
			.select()
			.from(memories)
			.where(and(eq(memories.projectId, projectId), eq(memories.status, "active")))
			.all()) as Array<{
			id: string;
			topic: string | null;
			content: string | null;
			confidence: number;
			curated: number;
			updatedAt: string | null;
		}>;

		/* 3. Build prompt */
		const prompt = buildConsolidationPrompt(
			allSessions.map((s) => ({ rawText: s.rawText })),
			existingMemories.map((m) => ({ topic: m.topic, content: m.content })),
		);

		/* 4. Call Firepass */
		const extracted = extractor
			? await extractor(prompt, apiKey, model)
			: await callFirepass(prompt, apiKey, model);

		if (!extracted) {
			// Firepass failure: leave sessions unchanged (pending stay 0, error stay -1)
			return { consolidated: 0, archived: 0, error: "Firepass consolidation failed" };
		}

		/* 5. Dedup and merge consolidated facts */
		const factsToInsert: Fact[] = [];
		const updates: Array<{ id: string; content?: string; confidence: number }> = [];

		for (const fact of extracted.facts.filter((f) => f.confidence >= 0.7)) {
			let matched = false;
			for (const mem of existingMemories) {
				if (jaccardSimilarity(fact.content, mem.content ?? "") > 0.6) {
					matched = true;
					if (mem.curated === 1) {
						// Corroboration refresh: update curated fact's updated_at
						await db.update(memories).set({ updatedAt: now }).where(eq(memories.id, mem.id)).run();
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
							confidence: mem.confidence,
						});
					}
					break;
				}
			}
			if (!matched) {
				factsToInsert.push(fact);
			}
		}

		for (const u of updates) {
			await db
				.update(memories)
				.set({
					updatedAt: now,
					...(u.content !== undefined ? { content: u.content } : {}),
					confidence: u.confidence,
				})
				.where(eq(memories.id, u.id))
				.run();
		}

		for (const f of factsToInsert) {
			await db
				.insert(memories)
				.values({
					id: crypto.randomUUID(),
					projectId,
					sourceSession: allSessions[0]?.id ?? crypto.randomUUID(),
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

		/* 6. Auto-archive stale curated facts (>90 days without recent corroboration) */
		// Re-query because dedup may have refreshed updated_at on corroborated curated facts
		const curatedFacts = (await db
			.select()
			.from(memories)
			.where(
				and(
					eq(memories.projectId, projectId),
					eq(memories.curated, 1),
					eq(memories.status, "active"),
				),
			)
			.all()) as Array<{
			id: string;
			updatedAt: string | null;
		}>;

		let archivedCount = 0;
		for (const cf of curatedFacts) {
			if (cf.updatedAt && cf.updatedAt < staleThreshold) {
				await db
					.update(memories)
					.set({ status: "archived", updatedAt: now })
					.where(eq(memories.id, cf.id))
					.run();
				archivedCount++;
			}
		}

		/* 7. Mark sessions as consolidated and prune raw_text */
		for (const s of allSessions) {
			await db
				.update(sessions)
				.set({ consolidated: 1, rawText: null, extractionError: null })
				.where(eq(sessions.id, s.id))
				.run();
		}

		return { consolidated: allSessions.length, archived: archivedCount };
	} finally {
		inFlight.delete(projectId);
	}
}

/* ───────── Cron: consolidate all projects with >=2 unconsolidated sessions ───────── */

export async function runCronConsolidation(
	db: DbLike,
	env: { FIREWORKS_API_KEY?: string; FIREWORKS_MODEL?: string },
): Promise<{ projectsProcessed: number; totalSessions: number; totalArchived: number }> {
	let projectsProcessed = 0;
	let totalSessions = 0;
	let totalArchived = 0;

	// Query projects with >=2 unconsolidated sessions
	const rows = (await db
		.select({ projectId: sessions.projectId })
		.from(sessions)
		.where(eq(sessions.consolidated, 0))
		.groupBy(sessions.projectId)
		.having(sql`count(*) >= 2`)
		.all()) as Array<{ projectId: string }>;

	for (const row of rows) {
		const result = await runConsolidation(row.projectId, db, env);
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
	const { drizzle } = require("drizzle-orm/d1");
	return drizzle(c.env.DB);
}

export function createConsolidateRoute(
	// biome-ignore lint/suspicious/noExplicitAny: Hono generic typing too restrictive for route wrappers
	app: any,
	// biome-ignore lint/suspicious/noExplicitAny: test override
	db?: any,
	opts?: {
		// biome-ignore lint/suspicious/noExplicitAny: env bindings vary across Workers runtimes
		getEnv?: (c: any) => { FIREWORKS_API_KEY?: string; FIREWORKS_MODEL?: string };
		extractor?: (prompt: string, apiKey: string, model: string) => Promise<Extracted | null>;
	},
) {
	// biome-ignore lint/suspicious/noExplicitAny: Hono context types are runtime-specific
	app.post("/consolidate", async (c: any) => {
		const dbCtx = db || getDb(c);

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
