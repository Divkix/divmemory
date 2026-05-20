import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { memories, projects, sessions } from "../schema";

type DbLike = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, unknown>>;

function getDb(c: { env: { DB: D1Database } }) {
	return drizzle(c.env.DB);
}

function countExpr() {
	return sql<number>`count(*)`;
}

// biome-ignore lint/suspicious/noExplicitAny: Hono generic typing too restrictive for route tests
export function createStatusRoute(app: any, db?: DbLike) {
	// biome-ignore lint/suspicious/noExplicitAny: Hono context types vary across runtimes
	app.get("/status", async (c: any) => {
		const dbCtx = db || getDb(c);
		const projectId = c.req.query("project") as string | undefined;

		if (projectId) {
			const project = dbCtx.select().from(projects).where(eq(projects.id, projectId)).get() as
				| {
						id: string;
						name: string | null;
						sessionCount: number | null;
						lastSeen: string | null;
						consolidationInProgress: number | null;
				  }
				| undefined;

			const sessionTotal = dbCtx
				.select({ count: countExpr() })
				.from(sessions)
				.where(eq(sessions.projectId, projectId))
				.get() as { count: number } | undefined;
			const pending = dbCtx
				.select({ count: countExpr() })
				.from(sessions)
				.where(and(eq(sessions.projectId, projectId), eq(sessions.consolidated, 0)))
				.get() as { count: number } | undefined;
			const errors = dbCtx
				.select({ count: countExpr() })
				.from(sessions)
				.where(and(eq(sessions.projectId, projectId), eq(sessions.consolidated, -1)))
				.get() as { count: number } | undefined;
			const active = dbCtx
				.select({ count: countExpr() })
				.from(memories)
				.where(and(eq(memories.projectId, projectId), eq(memories.status, "active")))
				.get() as { count: number } | undefined;
			const curated = dbCtx
				.select({ count: countExpr() })
				.from(memories)
				.where(
					and(
						eq(memories.projectId, projectId),
						eq(memories.status, "active"),
						eq(memories.curated, 1),
					),
				)
				.get() as { count: number } | undefined;
			const lastError = dbCtx
				.select({ error: sessions.extractionError })
				.from(sessions)
				.where(and(eq(sessions.projectId, projectId), eq(sessions.consolidated, -1)))
				.orderBy(desc(sessions.createdAt))
				.get() as { error: string | null } | undefined;

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

		const projectTotal = dbCtx.select({ count: countExpr() }).from(projects).get() as
			| { count: number }
			| undefined;
		const sessionTotal = dbCtx.select({ count: countExpr() }).from(sessions).get() as
			| { count: number }
			| undefined;
		const pending = dbCtx
			.select({ count: countExpr() })
			.from(sessions)
			.where(eq(sessions.consolidated, 0))
			.get() as { count: number } | undefined;
		const errors = dbCtx
			.select({ count: countExpr() })
			.from(sessions)
			.where(eq(sessions.consolidated, -1))
			.get() as { count: number } | undefined;
		const active = dbCtx
			.select({ count: countExpr() })
			.from(memories)
			.where(eq(memories.status, "active"))
			.get() as { count: number } | undefined;

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
