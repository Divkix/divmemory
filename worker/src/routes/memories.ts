import { and, desc, eq, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DbLike } from "../lib/db";
import { runAtomic } from "../lib/db";
import { isValidTopic, VALID_TOPICS } from "../lib/topics";
import { jaccardSimilarity } from "../lib/utils";
import { memories, projects, sessions } from "../schema";

/* ───────── helpers ───────── */

function getDb(c: { env: { DB: D1Database } }) {
	return drizzle(c.env.DB);
}

function nowISO(): string {
	return new Date().toISOString();
}

/* ───────── route ───────── */

// biome-ignore lint/suspicious/noExplicitAny: Hono generic typing too restrictive for our use case
export function createMemoriesRoute(app: any, db?: DbLike) {
	// biome-ignore lint/suspicious/noExplicitAny: Hono context types vary across runtimes
	app.post("/memories", async (c: any) => {
		const dbCtx = db || getDb(c);

		let body: { project_id?: string; project_name?: string; content?: string; topic?: string };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (!body.project_id || typeof body.project_id !== "string" || body.project_id.trim() === "") {
			return c.json({ error: "Missing or invalid field: project_id" }, 400);
		}
		if (!body.content || typeof body.content !== "string" || body.content.trim() === "") {
			return c.json({ error: "Missing or invalid field: content" }, 400);
		}

		const topic = body.topic ?? "general";
		if (!isValidTopic(topic)) {
			return c.json(
				{
					error: `Invalid topic '${topic}'. Valid topics: ${VALID_TOPICS.join(", ")}`,
				},
				400,
			);
		}

		const now = nowISO();
		const projectId = body.project_id;
		const content = body.content as string;

		const existingRows = (await dbCtx
			.select()
			.from(memories)
			.where(and(eq(memories.projectId, projectId), eq(memories.status, "active")))
			.all()) as Array<{ id: string; content: string | null }>;
		for (const row of existingRows) {
			if (row.content && jaccardSimilarity(body.content.trim(), row.content) > 0.6) {
				await dbCtx
					.update(memories)
					.set({
						updatedAt: now,
						curated: 1,
						confidence: 1,
					})
					.where(eq(memories.id, row.id))
					.run();
				return c.json(
					{ ok: true, id: row.id, deduped: true, curated: 1, confidence: 1, topic },
					200,
				);
			}
		}

		const memoryId = crypto.randomUUID();
		const sessionId = `manual:${memoryId}`;

		// Atomic: project upsert → session insert → memory insert
		await runAtomic(dbCtx, async (tx, addStmt) => {
			const project = (await tx.select().from(projects).where(eq(projects.id, projectId)).get()) as
				| { id: string }
				| undefined;
			if (project) {
				addStmt(tx.update(projects).set({ lastSeen: now }).where(eq(projects.id, projectId)));
			} else {
				addStmt(
					tx.insert(projects).values({
						id: projectId,
						name: body.project_name || projectId.split("/").pop() || projectId,
						sessionCount: 0,
						createdAt: now,
						lastSeen: now,
					}),
				);
			}
			addStmt(
				tx.insert(sessions).values({
					id: sessionId,
					projectId,
					source: "manual-add",
					rawText: content,
					consolidated: 1,
					extractionError: null,
					tokenCount: content.length,
					metadata: JSON.stringify({ manual: true }),
					createdAt: now,
				}),
			);
			addStmt(
				tx.insert(memories).values({
					id: memoryId,
					projectId,
					sourceSession: sessionId,
					topic,
					content: content.trim(),
					confidence: 1,
					curated: 1,
					status: "active",
					createdAt: now,
					updatedAt: now,
				}),
			);
		});

		return c.json({ ok: true, id: memoryId, curated: 1, confidence: 1, topic }, 201);
	});

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
		const existing = (await dbCtx.select().from(memories).where(eq(memories.id, id)).get()) as
			| { id: string }
			| undefined;
		if (!existing) {
			return c.json({ error: "Memory not found" }, 404);
		}

		await dbCtx.update(memories).set(set).where(eq(memories.id, id)).run();

		return c.json({ ok: true }, 200);
	});

	// biome-ignore lint/suspicious/noExplicitAny: Hono context types vary across runtimes
	app.delete("/memories/:id", async (c: any) => {
		const dbCtx = db || getDb(c);
		const id = c.req.param("id") as string;

		const row = (await dbCtx.select().from(memories).where(eq(memories.id, id)).get()) as
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
			await dbCtx
				.update(memories)
				.set({ status: "archived", updatedAt: nowISO() })
				.where(eq(memories.id, id))
				.run();
			return c.json({ ok: true }, 200);
		}

		// Hard-delete auto-extracted (curated=0) regardless of current status
		await dbCtx.delete(memories).where(eq(memories.id, id)).run();
		return c.json({ ok: true }, 200);
	});
}
