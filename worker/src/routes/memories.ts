import { and, desc, eq, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { memories, projects } from "../schema";

/* ───────── types ───────── */

type DbLike = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, unknown>>;

const VALID_TOPICS = ["project_context", "decisions", "issues", "preferences", "general"] as const;

/* ───────── helpers ───────── */

function getDb(c: { env: { DB: D1Database } }) {
	return drizzle(c.env.DB);
}

function nowISO(): string {
	return new Date().toISOString();
}

function isValidTopic(topic: string): topic is (typeof VALID_TOPICS)[number] {
	return VALID_TOPICS.includes(topic as (typeof VALID_TOPICS)[number]);
}

/* ───────── route ───────── */

// biome-ignore lint/suspicious/noExplicitAny: Hono generic typing too restrictive for our use case
export function createMemoriesRoute(app: any, db?: DbLike) {
	// biome-ignore lint/suspicious/noExplicitAny: Hono context types vary across runtimes
	app.get("/memories", async (c: any) => {
		const dbCtx = db || getDb(c);
		const projectId = c.req.query("project") as string | undefined;
		const search = c.req.query("search") as string | undefined;
		const statusParam = c.req.query("status") as string | undefined;

		const statusFilter = statusParam === "archived" ? "archived" : "active";

		// Build conditions dynamically with parameterized queries (Drizzle)
		const conditions = [eq(memories.status, statusFilter)];
		if (projectId) {
			conditions.push(eq(memories.projectId, projectId));
		}

		let rows: Array<{
			id: string;
			projectId: string;
			topic: string | null;
			content: string | null;
			confidence: number | null;
			curated: number | null;
			status: string | null;
			updatedAt: string | null;
		}>;

		if (search && search.trim().length > 0) {
			// Case-insensitive substring search using LIKE with lowercase
			const pattern = `%${search.toLowerCase()}%`;
			rows = (await dbCtx
				.select()
				.from(memories)
				.where(and(...conditions, like(sql`lower(${memories.content})`, pattern)))
				.orderBy(desc(memories.updatedAt))
				.all()) as typeof rows;
		} else {
			rows = (await dbCtx
				.select()
				.from(memories)
				.where(and(...conditions))
				.orderBy(desc(memories.updatedAt))
				.all()) as typeof rows;
		}

		// Group by project, then by topic
		const projectMap = new Map<
			string,
			{ id: string; name: string; topics: Map<string, Array<unknown>> }
		>();

		for (const row of rows) {
			const pid = row.projectId;
			if (!projectMap.has(pid)) {
				// Fetch project name
				const proj = (await dbCtx.select().from(projects).where(eq(projects.id, pid)).get()) as
					| { id: string; name: string | null }
					| undefined;
				projectMap.set(pid, {
					id: pid,
					name: proj?.name || pid.split("/").pop() || pid,
					topics: new Map(),
				});
			}
			const p = projectMap.get(pid);
			if (!p) continue;
			const topic = row.topic || "general";
			if (!p.topics.has(topic)) {
				p.topics.set(topic, []);
			}
			p.topics.get(topic)?.push({
				id: row.id,
				content: row.content,
				confidence: row.confidence,
				curated: row.curated,
				status: row.status,
				updated_at: row.updatedAt,
			});
		}

		// Convert to response format
		const result = {
			projects: Array.from(projectMap.values()).map((p) => ({
				id: p.id,
				name: p.name,
				topics: Object.fromEntries(p.topics),
			})),
		};

		return c.json(result, 200);
	});

	// biome-ignore lint/suspicious/noExplicitAny: Hono context types vary across runtimes
	app.patch("/memories/:id", async (c: any) => {
		const dbCtx = db || getDb(c);
		const id = c.req.param("id") as string;

		let body: { content?: string; topic?: string; status?: string };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		// Validate topic before touching DB
		if (body.topic !== undefined && !isValidTopic(body.topic)) {
			return c.json(
				{
					error: `Invalid topic '${body.topic}'. Valid topics: ${VALID_TOPICS.join(", ")}`,
				},
				400,
			);
		}

		// Build update set
		const set: Record<string, unknown> = {
			updatedAt: nowISO(),
		};

		if (body.content !== undefined) {
			set.content = body.content;
		}
		if (body.topic !== undefined) {
			set.topic = body.topic;
		}
		if (body.status !== undefined) {
			set.status = body.status;
		}

		// If any meaningful field is being updated, auto-set curated=1
		if (body.content !== undefined || body.topic !== undefined || body.status !== undefined) {
			// Per VAL-API-116: curated facts get confidence=1.0 after edit
			set.curated = 1;
			set.confidence = 1.0;
		}

		// Check if memory exists
		const existing = dbCtx.select().from(memories).where(eq(memories.id, id)).get() as
			| { id: string }
			| undefined;
		if (!existing) {
			return c.json({ error: "Memory not found" }, 404);
		}

		dbCtx.update(memories).set(set).where(eq(memories.id, id)).run();

		return c.json({ ok: true }, 200);
	});

	// biome-ignore lint/suspicious/noExplicitAny: Hono context types vary across runtimes
	app.delete("/memories/:id", async (c: any) => {
		const dbCtx = db || getDb(c);
		const id = c.req.param("id") as string;

		const row = dbCtx.select().from(memories).where(eq(memories.id, id)).get() as
			| { id: string; curated: number; status: string }
			| undefined;

		if (!row) {
			return c.json({ error: "Memory not found" }, 404);
		}

		// If already archived (curated=1 + status=archived), treat as already done
		if (row.curated === 1 && row.status === "archived") {
			return c.json({ ok: true }, 200);
		}

		if (row.curated === 1) {
			// Soft-archive curated facts
			dbCtx
				.update(memories)
				.set({ status: "archived", updatedAt: nowISO() })
				.where(eq(memories.id, id))
				.run();
			return c.json({ ok: true }, 200);
		}

		// Hard-delete auto-extracted (curated=0) regardless of current status
		dbCtx.delete(memories).where(eq(memories.id, id)).run();
		return c.json({ ok: true }, 200);
	});
}
