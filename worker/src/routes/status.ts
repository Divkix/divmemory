import { and, desc, eq, sql } from "drizzle-orm";
import { createDatabaseFromEnv } from "../db";
import type { Database } from "../db";
import { memories, projects, sessions } from "../schema";

function getDb(c: { env: { DB: D1Database } }) {
	return createDatabaseFromEnv(c.env.DB);
}

function countExpr() {
	return sql<number>`count(*)`;
}

// biome-ignore lint/suspicious/noExplicitAny: Hono generic typing too restrictive for route tests
export function createStatusRoute(app: any, db?: Database) {
	// biome-ignore lint/suspicious/noExplicitAny: Hono context types vary across runtimes
	app.get("/status", async (c: any) => {
		const dbCtx = db || getDb(c);
		const projectId = c.req.query("project") as string | undefined;

		if (projectId) {
			const project = await dbCtx.select().from(projects).where(eq(projects.id, projectId)).get();

			const sessionTotal = await dbCtx
				.select({ count: countExpr() })
				.from(sessions)
				.where(eq(sessions.projectId, projectId))
				.get();
			const pending = await dbCtx
				.select({ count: countExpr() })
				.from(sessions)
				.where(and(eq(sessions.projectId, projectId), eq(sessions.consolidated, 0)))
				.get();
			const errors = await dbCtx
				.select({ count: countExpr() })
				.from(sessions)
				.where(and(eq(sessions.projectId, projectId), eq(sessions.consolidated, -1)))
				.get();
			const active = await dbCtx
				.select({ count: countExpr() })
				.from(memories)
				.where(and(eq(memories.projectId, projectId), eq(memories.status, "active")))
				.get();
			const curated = await dbCtx
				.select({ count: countExpr() })
				.from(memories)
				.where(
					and(
						eq(memories.projectId, projectId),
						eq(memories.status, "active"),
						eq(memories.curated, 1),
					),
				)
				.get();
			const lastError = await dbCtx
				.select({ error: sessions.extractionError })
				.from(sessions)
				.where(and(eq(sessions.projectId, projectId), eq(sessions.consolidated, -1)))
				.orderBy(desc(sessions.createdAt))
				.get();

			return c.json({
				project_id: projectId,
				project_name: project?.name ?? projectId.split("/").pop() ?? projectId,
				last_seen: project?.lastSeen ?? null,
				sessions: {
					total: sessionTotal?.count ?? 0,
					pending_extraction: pending?.count ?? 0,
					extraction_errors: errors?.count ?? 0,
				},
				memories: {
					active: active?.count ?? 0,
					curated: curated?.count ?? 0,
				},
				consolidation: {
					in_progress: (project?.consolidationInProgress ?? 0) === 1,
				},
				last_error: lastError?.error ?? null,
			});
		}

		const projectTotal = await dbCtx.select({ count: countExpr() }).from(projects).get();
		const sessionTotal = await dbCtx.select({ count: countExpr() }).from(sessions).get();
		const pending = await dbCtx
			.select({ count: countExpr() })
			.from(sessions)
			.where(eq(sessions.consolidated, 0))
			.get();
		const errors = await dbCtx
			.select({ count: countExpr() })
			.from(sessions)
			.where(eq(sessions.consolidated, -1))
			.get();
		const active = await dbCtx
			.select({ count: countExpr() })
			.from(memories)
			.where(eq(memories.status, "active"))
			.get();

		return c.json({
			projects: { total: projectTotal?.count ?? 0 },
			sessions: {
				total: sessionTotal?.count ?? 0,
				pending_extraction: pending?.count ?? 0,
				extraction_errors: errors?.count ?? 0,
			},
			memories: { active: active?.count ?? 0 },
		});
	});
}
