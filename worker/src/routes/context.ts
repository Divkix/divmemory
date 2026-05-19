import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { memories, projects } from "../schema";

/* ───────── types ───────── */

type DbLike = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, unknown>>;

const TOPIC_ORDER = [
	{ key: "project_context", label: "Project Context" },
	{ key: "decisions", label: "Recent Decisions" },
	{ key: "issues", label: "Known Issues / Watch Out" },
	{ key: "preferences", label: "Your Preferences" },
	{ key: "general", label: "General" },
];

const DEFAULT_MAX_CHARS = 12000;
const MIN_CHARS_PER_TOPIC = 500;

/* ───────── helpers ───────── */

function getDb(c: { env: { DB: D1Database } }) {
	return drizzle(c.env.DB);
}

function nowISO(): string {
	return new Date().toISOString();
}

function formatHeader(projectName: string, factCount: number, updatedAt: string): string {
	return `## divmemory — ${projectName}

_Last updated ${updatedAt}_ · _${factCount} fact${factCount === 1 ? "" : "s"}_
`;
}

function formatTopicSection(label: string, facts: Array<{ content: string }>): string {
	if (facts.length === 0) return "";
	const lines = facts.map((f) => `- ${f.content}`);
	return `\n### ${label}\n\n${lines.join("\n")}`;
}

/**
 * Topic-balanced truncation:
 * 1. Build full sections for each topic
 * 2. Calculate per-topic minimum guarantee (500 chars)
 * 3. Allocate minimum to each populated topic
 * 4. Distribute remaining budget proportionally
 * 5. Truncate individual sections then concatenate
 */
function truncateContext(
	sections: Array<{ label: string; text: string; factCount: number }>,
	maxChars: number,
): string {
	const populated = sections.filter((s) => s.factCount > 0);
	if (populated.length === 0) return "";

	// Minimum guarantee per populated topic
	const minPerTopic = MIN_CHARS_PER_TOPIC;
	const totalMin = populated.length * minPerTopic;

	// Header overhead estimate (already counted separately; sections are just topic bodies)
	const budget = maxChars;

	// If even minimums exceed budget, give each topic an equal tiny slice
	if (totalMin > budget) {
		const slicePerTopic = Math.floor(budget / populated.length);
		let result = "";
		for (const sec of populated) {
			result += sec.text.slice(0, slicePerTopic);
		}
		return result;
	}

	// First pass: give each populated topic its minimum
	const allocations = new Map<string, number>();
	for (const sec of populated) {
		allocations.set(sec.label, minPerTopic);
	}
	const remaining = budget - totalMin;

	// Second pass: distribute remaining proportionally by section length
	const totalExtra = populated.reduce(
		(sum, s) => sum + Math.max(0, s.text.length - minPerTopic),
		0,
	);
	if (totalExtra > 0 && remaining > 0) {
		for (const sec of populated) {
			const extra = Math.max(0, sec.text.length - minPerTopic);
			const share = Math.floor((extra / totalExtra) * remaining);
			allocations.set(sec.label, (allocations.get(sec.label) || 0) + share);
		}
	} else if (remaining > 0) {
		// All sections are shorter than min — distribute evenly
		const share = Math.floor(remaining / populated.length);
		for (const sec of populated) {
			allocations.set(sec.label, (allocations.get(sec.label) || 0) + share);
		}
	}

	// Build result by truncating each section to its allocation
	let result = "";
	for (const sec of populated) {
		const alloc = allocations.get(sec.label) || minPerTopic;
		result += sec.text.slice(0, alloc);
	}
	return result;
}

/* ───────── route ───────── */

// biome-ignore lint/suspicious/noExplicitAny: Hono generic typing too restrictive
export function createContextRoute(app: any, db?: DbLike) {
	// biome-ignore lint/suspicious/noExplicitAny: Hono context types vary across runtimes
	app.get("/context", async (c: any) => {
		const projectId = c.req.query("project");
		if (!projectId || typeof projectId !== "string" || projectId.trim() === "") {
			return c.json({ error: "Missing required query parameter: project" }, 400);
		}

		const rawMax = c.req.query("max_chars");
		let maxChars = DEFAULT_MAX_CHARS;
		if (rawMax !== undefined) {
			const parsed = Number.parseInt(rawMax, 10);
			if (!Number.isNaN(parsed) && parsed > 0) {
				maxChars = parsed;
			}
		}

		const dbCtx = db || getDb(c);

		// Fetch project info if it exists
		const project = (await dbCtx.select().from(projects).where(eq(projects.id, projectId)).get()) as
			| { id: string; name: string | null }
			| undefined;

		const projectName = project?.name || projectId.split("/").pop() || projectId;

		// Fetch active memories with curated facts first, then newest first.
		const rows = (await dbCtx
			.select()
			.from(memories)
			.where(and(eq(memories.projectId, projectId), eq(memories.status, "active")))
			.orderBy(desc(memories.curated), desc(memories.updatedAt))
			.all()) as Array<{
			id: string;
			projectId: string;
			topic: string | null;
			content: string | null;
			curated: number | null;
			updatedAt: string | null;
		}>;

		// Group by topic
		const byTopic = new Map<string, Array<{ content: string }>>();
		for (const row of rows) {
			const topic = row.topic || "general";
			if (!byTopic.has(topic)) {
				byTopic.set(topic, []);
			}
			if (row.content) {
				byTopic.get(topic)?.push({ content: row.content });
			}
		}

		const factCount = rows.length;
		const updatedAt = rows.length > 0 ? rows[0].updatedAt || nowISO() : nowISO();

		// Build sections in consistent topic order
		const sections: Array<{ label: string; text: string; factCount: number }> = [];
		for (const t of TOPIC_ORDER) {
			const facts = byTopic.get(t.key) || [];
			if (facts.length === 0) continue;
			const text = formatTopicSection(t.label, facts);
			sections.push({ label: t.label, text, factCount: facts.length });
		}

		// Handle remaining topics not in TOPIC_ORDER (fallback)
		for (const [topicKey, facts] of byTopic) {
			if (TOPIC_ORDER.some((t) => t.key === topicKey)) continue;
			if (facts.length === 0) continue;
			const text = formatTopicSection(topicKey, facts);
			sections.push({ label: topicKey, text, factCount: facts.length });
		}

		let body: string;
		if (factCount === 0) {
			body = `${formatHeader(projectName, 0, updatedAt)}\n_No memories recorded yet._\n`;
		} else {
			const header = formatHeader(projectName, factCount, updatedAt);
			const topicText = truncateContext(sections, maxChars - header.length);
			body = `${header + topicText}\n`;
		}

		return c.text(`${body.trimEnd()}\n`, 200, {
			"Content-Type": "text/plain; charset=utf-8",
		});
	});
}
