/** @jsxImportSource hono/jsx */
import { and, desc, eq, like, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isSecureContext, verifyCookie } from "../auth";
import { generateCsrfToken, verifyCsrfToken } from "../csrf";
import type { Database, MemoryRow, SessionRow } from "../db";
import { createDatabaseFromEnv } from "../db";
import { memories, projects, sessions } from "../schema";
import { LoginPage, MainPage } from "../webui/components";
import * as consolidate from "./consolidate";
import { cascadeDeleteNearDuplicates } from "./memories";

const SESSION_COOKIE = "divmemory_session";

function getDb(c: Context, db?: Database): Database {
	if (db) return db;
	return createDatabaseFromEnv(c.env.DB as unknown as D1Database);
}

function webCookieSecret(c: Context): string {
	return (
		(c.env.COOKIE_SECRET as string | undefined) ||
		(c.env.DIVMEMORY_WEB_PASSWORD as string | undefined) ||
		""
	);
}

function redirectCookieAuth(sessionCookieName: string): MiddlewareHandler {
	return async (c, next) => {
		const secret = webCookieSecret(c);
		const raw = getCookie(c, sessionCookieName);
		if (!raw) {
			return c.redirect("/login", 302);
		}
		const payload = await verifyCookie(raw, secret);
		if (!payload) {
			return c.redirect("/login", 302);
		}
		let data: { exp?: number } = {};
		try {
			data = JSON.parse(payload);
		} catch {
			return c.redirect("/login", 302);
		}
		if (data.exp && Date.now() > data.exp * 1000) {
			return c.redirect("/login", 302);
		}
		c.set("session", data);
		return next();
	};
}

async function makeCsrf(c: Context): Promise<string> {
	const secret = webCookieSecret(c);
	const csrfFull = await generateCsrfToken(secret);
	const [csrfValue] = csrfFull.split(":");
	setCookie(c, "csrf_cookie", csrfFull, {
		httpOnly: true,
		secure: isSecureContext(c),
		sameSite: "Strict",
		path: "/",
		maxAge: 3600,
	});
	return csrfValue;
}

async function validateCsrf(c: Context): Promise<boolean> {
	const secret = webCookieSecret(c);
	const csrfCookie = getCookie(c, "csrf_cookie");
	const body = await c.req.parseBody();
	const formCsrf = String(body.csrf_token || "");
	const headerCsrf = c.req.header("X-CSRF-Token") || "";
	if (!csrfCookie) return false;
	if (!formCsrf && !headerCsrf) return false;
	const { valid, value } = await verifyCsrfToken(csrfCookie, secret);
	return valid && (value === formCsrf || value === headerCsrf);
}

export function createWebUiRoute(
	// biome-ignore lint/suspicious/noExplicitAny: Hono generic typing too restrictive
	app: any,
	db?: Database,
) {
	/* ── GET login ── */
	app.get("/login", async (c: Context) => {
		const error = c.req.query("error") || "";
		const redirect = c.req.query("redirect") || "/";
		return c.html(<LoginPage error={error} redirect={redirect} />);
	});

	/* ── auth helper middleware ── */
	const auth = redirectCookieAuth(SESSION_COOKIE);

	/* ── GET main UI ── */
	app.get("/", auth, async (c: Context) => {
		const dbCtx = getDb(c, db);
		const projectId = c.req.query("project");
		const editId = c.req.query("edit");
		const deleteId = c.req.query("delete");
		const showArchived = c.req.query("archived") === "1";
		const searchQuery = c.req.query("search") || "";
		const success = c.req.query("success") || "";
		const error = c.req.query("error") || "";

		// Fetch all projects for sidebar
		const allProjectsRaw = await dbCtx.select().from(projects).all();
		allProjectsRaw.sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""));

		let currentProject:
			| { id: string; name: string | null; sessionCount: number | null }
			| undefined = allProjectsRaw.find((p) => p.id === projectId);
		if (!currentProject && !projectId && allProjectsRaw.length === 1) {
			currentProject = allProjectsRaw[0];
		}
		let pageError = error;

		let memRows: MemoryRow[] = [];
		let sessionRows: SessionRow[] = [];
		let unconsolidatedCount = 0;
		let statusStats = {
			activeMemories: 0,
			curatedMemories: 0,
			pendingSessions: 0,
			errorSessions: 0,
		};
		let queriedProjectId: string | undefined;

		if (currentProject) {
			queriedProjectId = currentProject.id;
			const conditions = [
				eq(memories.projectId, queriedProjectId),
				eq(memories.status, showArchived ? "archived" : "active"),
			];
			if (searchQuery.trim()) {
				conditions.push(like(sql`lower(${memories.content})`, `%${searchQuery.toLowerCase()}%`));
			}
			memRows = await dbCtx
				.select()
				.from(memories)
				.where(and(...conditions))
				.orderBy(desc(memories.updatedAt))
				.all();

			sessionRows = await dbCtx
				.select()
				.from(sessions)
				.where(eq(sessions.projectId, queriedProjectId))
				.orderBy(desc(sessions.createdAt))
				.limit(20)
				.all();

			const ucResult = await dbCtx
				.select({ count: sql<number>`count(*)` })
				.from(sessions)
				.where(and(eq(sessions.projectId, queriedProjectId), eq(sessions.consolidated, 0)))
				.get();
			unconsolidatedCount = ucResult?.count ?? 0;

			const activeResult = await dbCtx
				.select({ count: sql<number>`count(*)` })
				.from(memories)
				.where(and(eq(memories.projectId, queriedProjectId), eq(memories.status, "active")))
				.get();
			const curatedResult = await dbCtx
				.select({ count: sql<number>`count(*)` })
				.from(memories)
				.where(
					and(
						eq(memories.projectId, queriedProjectId),
						eq(memories.status, "active"),
						eq(memories.curated, 1),
					),
				)
				.get();
			const errorResult = await dbCtx
				.select({ count: sql<number>`count(*)` })
				.from(sessions)
				.where(and(eq(sessions.projectId, queriedProjectId), eq(sessions.consolidated, -1)))
				.get();
			statusStats = {
				activeMemories: activeResult?.count ?? 0,
				curatedMemories: curatedResult?.count ?? 0,
				pendingSessions: unconsolidatedCount,
				errorSessions: errorResult?.count ?? 0,
			};

			if (editId) {
				const editExists = await dbCtx
					.select({ id: memories.id })
					.from(memories)
					.where(eq(memories.id, editId))
					.get();
				if (!editExists) {
					pageError = "Memory not found";
				}
			}
			if (deleteId) {
				const deleteExists = await dbCtx
					.select({ id: memories.id })
					.from(memories)
					.where(eq(memories.id, deleteId))
					.get();
				if (!deleteExists) {
					pageError = "Memory not found";
				}
			}
		} else if (projectId) {
			// Nonexistent project selected
			currentProject = { id: projectId, name: projectId, sessionCount: 0 };
			queriedProjectId = projectId;
			pageError = "Project not found";
		}

		const csrfValue = await makeCsrf(c);

		return c.html(
			<MainPage
				allProjects={allProjectsRaw}
				currentProject={currentProject}
				memRows={memRows}
				sessionRows={sessionRows}
				unconsolidatedCount={unconsolidatedCount}
				statusStats={statusStats}
				searchQuery={searchQuery}
				editId={editId}
				deleteId={deleteId}
				showArchived={showArchived}
				csrfValue={csrfValue}
				success={success}
				error={pageError}
			/>,
		);
	});

	/* ── POST form handler ── */
	app.post("/", auth, async (c: Context) => {
		const dbCtx = getDb(c, db);
		const valid = await validateCsrf(c);
		if (!valid) {
			return c.text("Forbidden — invalid CSRF token", 403);
		}

		const body = await c.req.parseBody();
		const projectId = String(body.project || "");
		const methodOverride = String(body._method || "").toUpperCase();

		// Consolidate action (runs regardless of _method)
		if (body.action === "consolidate") {
			const env: { FIREWORKS_API_KEY?: string; FIREWORKS_MODEL?: string } = {
				FIREWORKS_API_KEY: String((c.env as Record<string, string>).FIREWORKS_API_KEY || ""),
				FIREWORKS_MODEL: String((c.env as Record<string, string>).FIREWORKS_MODEL || ""),
			};
			const result = await consolidate.runConsolidation(projectId, dbCtx, env);
			if (result.error) {
				return c.redirect(
					`/?project=${encodeURIComponent(projectId)}&error=${encodeURIComponent(result.error)}`,
					302,
				);
			}
			return c.redirect(
				`/?project=${encodeURIComponent(projectId)}&success=${encodeURIComponent(`Consolidated ${result.consolidated} sessions`)}`,
				302,
			);
		}

		// Edit memory
		if (methodOverride === "PATCH" && body.edit) {
			const memId = String(body.edit);
			const existing = await dbCtx
				.select()
				.from(memories)
				.where(and(eq(memories.id, memId), eq(memories.projectId, projectId)))
				.get();
			if (!existing) {
				return c.redirect(`/?project=${encodeURIComponent(projectId)}&error=Memory+not+found`, 302);
			}
			const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
			if (body.content !== undefined) set.content = String(body.content);
			if (body.topic !== undefined) set.topic = String(body.topic);
			if (Object.keys(set).length > 1) {
				set.curated = 1;
				set.confidence = 1.0;
			}
			await dbCtx
				.update(memories)
				.set(set)
				.where(and(eq(memories.id, memId), eq(memories.projectId, projectId)))
				.run();
			return c.redirect(`/?project=${encodeURIComponent(projectId)}&success=Memory+updated`, 302);
		}

		// Delete memory
		if (methodOverride === "DELETE" && body.delete) {
			const memId = String(body.delete);
			const row = await dbCtx
				.select()
				.from(memories)
				.where(and(eq(memories.id, memId), eq(memories.projectId, projectId)))
				.get();
			if (!row) {
				return c.redirect(`/?project=${encodeURIComponent(projectId)}&error=Memory+not+found`, 302);
			}
			if (row.curated === 1) {
				await dbCtx.atomic(async (collect) => {
					collect(
						dbCtx
							.update(memories)
							.set({ status: "archived", updatedAt: new Date().toISOString() })
							.where(and(eq(memories.id, memId), eq(memories.projectId, projectId))),
					);
					if (row.content) {
						await cascadeDeleteNearDuplicates(dbCtx, collect, projectId, row.content);
					}
				});
			} else {
				await dbCtx
					.delete(memories)
					.where(and(eq(memories.id, memId), eq(memories.projectId, projectId)))
					.run();
			}
			return c.redirect(`/?project=${encodeURIComponent(projectId)}&success=Memory+removed`, 302);
		}

		// Restore memory (PATCH + id + status=active)
		if (methodOverride === "PATCH" && body.id && body.status === "active") {
			const memId = String(body.id);
			await dbCtx
				.update(memories)
				.set({ status: "active", updatedAt: new Date().toISOString() })
				.where(and(eq(memories.id, memId), eq(memories.projectId, projectId)))
				.run();
			return c.redirect(`/?project=${encodeURIComponent(projectId)}&success=Memory+restored`, 302);
		}

		return c.redirect(`/?project=${encodeURIComponent(projectId)}`, 302);
	});

	/* ── POST logout ── */
	app.post("/logout", auth, async (c: Context) => {
		deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecureContext(c), sameSite: "Strict" });
		return c.redirect("/login", 302);
	});
}
