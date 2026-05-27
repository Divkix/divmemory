import { and, desc, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { Database } from "../db";
import { createDatabaseFromEnv } from "../db";
import { TOPIC_LABELS, TOPIC_ORDER, type TopicId } from "../lib/topics";
import { GLOBAL_PROJECT_ID, memories, projects } from "../schema";

const DEFAULT_MAX_CHARS = 12000;
const MIN_CHARS_PER_TOPIC = 500;

/** Maximum fraction of the total context budget allocated to global memories (25%). */
const GLOBAL_BUDGET_FRACTION = 0.25;

/* ───────── helpers ───────── */

function getDb(c: { env: { DB: D1Database } }) {
	return createDatabaseFromEnv(c.env.DB);
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

/** Format the global preferences section. Returns empty string if no global facts. */
function formatGlobalSection(globalFacts: Array<{ content: string }>): string {
	if (globalFacts.length === 0) return "";
	const lines = globalFacts.map((f) => `- ${f.content}`);
	return `\n### Global Preferences\n\n${lines.join("\n")}\n`;
}

/** Returns the override note if global facts exist; empty string otherwise. */
function formatGlobalOverrideNote(globalCount: number): string {
	if (globalCount === 0) return "";
	return `_Project-specific guidelines override global preferences in case of conflict._\n`;
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

export function createContextRoute<E extends Record<string, unknown>>(app: Hono<E>, db?: Database) {
	app.get("/context", async (c: Context<E>) => {
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

		const dbCtx = db || getDb(c as unknown as { env: { DB: D1Database } });

		// Fetch project info if it exists
		const project = await dbCtx.select().from(projects).where(eq(projects.id, projectId)).get();

		const projectName = project?.name || projectId.split("/").pop() || projectId;

		// Fetch active memories for the requested project
		const rows = await dbCtx
			.select()
			.from(memories)
			.where(and(eq(memories.projectId, projectId), eq(memories.status, "active")))
			.orderBy(desc(memories.curated), desc(memories.updatedAt))
			.all();

		// Also fetch global memories (cross-project developer preferences)
		const globalRows = await dbCtx
			.select()
			.from(memories)
			.where(and(eq(memories.projectId, GLOBAL_PROJECT_ID), eq(memories.status, "active")))
			.orderBy(desc(memories.curated), desc(memories.updatedAt))
			.all();

		// Extract global fact content
		const globalFacts: Array<{ content: string }> = [];
		for (const row of globalRows) {
			if (row.content) {
				globalFacts.push({ content: row.content });
			}
		}
		const globalCount = globalFacts.length;

		// Group project memories by topic
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
		let latestRow: string | null = null;
		for (const row of [...rows, ...globalRows]) {
			if (!row.updatedAt) continue;
			if (!latestRow || row.updatedAt > latestRow) {
				latestRow = row.updatedAt;
			}
		}
		const updatedAt = latestRow || nowISO();

		// Build project topic sections in consistent order
		const sections: Array<{ label: string; text: string; factCount: number }> = [];
		for (const t of TOPIC_ORDER) {
			const facts = byTopic.get(t) || [];
			if (facts.length === 0) continue;
			const label = TOPIC_LABELS[t] || t;
			const text = formatTopicSection(label, facts);
			sections.push({ label, text, factCount: facts.length });
		}

		// Handle remaining topics not in TOPIC_ORDER (fallback)
		for (const [topicKey, facts] of byTopic) {
			if (TOPIC_ORDER.includes(topicKey as TopicId)) continue;
			if (facts.length === 0) continue;
			const label = TOPIC_LABELS[topicKey as TopicId] || topicKey;
			const text = formatTopicSection(label, facts);
			sections.push({ label, text, factCount: facts.length });
		}

		// Build global section (if any)
		const globalSectionText = formatGlobalSection(globalFacts);
		const overrideNote = formatGlobalOverrideNote(globalCount);

		// Calculate budget: global gets at most 25%; unused cap flows to project content
		const globalCap = Math.floor(maxChars * GLOBAL_BUDGET_FRACTION);
		const globalBudget = Math.min(globalCap, globalSectionText.length);
		const projectBudget = maxChars - globalBudget;

		const totalFactCount = factCount + globalCount;
		const header = formatHeader(projectName, totalFactCount, updatedAt);

		// Truncate global section to its budget
		let globalText = "";
		if (globalSectionText) {
			globalText = globalSectionText.slice(0, globalBudget);
		}

		// Truncate project sections to project budget
		const topicText = truncateContext(sections, projectBudget);

		// Assemble: header + override note + global section + project topic sections
		let body: string;
		if (totalFactCount === 0) {
			body = `${formatHeader(projectName, 0, updatedAt)}\n_No memories recorded yet._\n`;
		} else {
			const bodyParts = [header, overrideNote, globalText, topicText].filter(Boolean);
			body = `${bodyParts.join("")}\n`;
		}

		return c.text(`${body.trimEnd()}\n`, 200, {
			"Content-Type": "text/plain; charset=utf-8",
		});
	});
}
