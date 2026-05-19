/** @jsxImportSource hono/jsx */
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { FC, PropsWithChildren } from "hono/jsx";
import { verifyCookie } from "../auth";
import { generateCsrfToken, verifyCsrfToken } from "../csrf";
import { memories, projects, sessions } from "../schema";
import * as consolidate from "./consolidate";

/* ───────── types ───────── */

type DbLike = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, unknown>>;

interface MemoryRow {
	id: string;
	projectId: string;
	sourceSession: string;
	topic: string | null;
	content: string | null;
	confidence: number | null;
	curated: number | null;
	status: string | null;
	createdAt: string | null;
	updatedAt: string | null;
}

interface SessionRow {
	id: string;
	projectId: string;
	source: string | null;
	rawText: string | null;
	consolidated: number | null;
	extractionError: string | null;
	tokenCount: number | null;
	metadata: string | null;
	createdAt: string | null;
}

/* ───────── constants ───────── */

const VALID_TOPICS = ["project_context", "decisions", "issues", "preferences", "general"] as const;

const TOPIC_ORDER = ["project_context", "decisions", "issues", "preferences", "general"] as const;

const TOPIC_LABELS: Record<string, string> = {
	project_context: "Project Context",
	decisions: "Recent Decisions",
	issues: "Known Issues / Watch Out",
	preferences: "Your Preferences",
	general: "General",
};

const SESSION_COOKIE = "divmemory_session";

/* ───────── helpers ───────── */

function getDb(c: Context, db?: DbLike): DbLike {
	if (db) return db;
	return drizzle(c.env.DB as unknown as D1Database);
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
		secure: true,
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

function topicLabel(topic: string | null): string {
	return TOPIC_LABELS[topic || "general"] || "General";
}

function confidencePercent(confidence: number | null): string {
	const c = confidence ?? 0;
	return `${Math.round(c * 100)}%`;
}

function sessionStatusLabel(row: SessionRow): string {
	const c = row.consolidated ?? 0;
	if (c === -1) return "Error";
	if (c === 0) return "Unconsolidated";
	return "Consolidated";
}

/* ───────── CSS ───────── */

const GLOBAL_CSS = `*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:0;background:#f4f4f5;color:#18181b;line-height:1.5}
.container{display:flex;height:100vh}
.sidebar{width:240px;background:#fafafa;border-right:1px solid #e4e4e7;padding:16px;overflow-y:auto}
.sidebar h2{font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#71717a;margin:0 0 12px}
.sidebar ul{list-style:none;margin:0;padding:0}
.sidebar li a{display:block;padding:8px 12px;color:#27272a;text-decoration:none;border-radius:6px;font-size:14px}
.sidebar li a:hover{background:#f4f4f5}
.sidebar li a.current{background:#e4e4e7;font-weight:600}
.sidebar .count{float:right;color:#71717a;font-size:12px}
.main{flex:1;overflow-y:auto;padding:20px}
.memories{max-width:900px}
.topic-group{margin-bottom:24px}
.topic-group h3{font-size:16px;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid #e4e4e7;color:#3f3f46;text-transform:capitalize}
.memory-card{background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:12px;margin-bottom:8px}
.memory-content{white-space:pre-wrap;word-break:break-word;margin-bottom:8px}
.memory-meta{font-size:12px;color:#71717a;margin-bottom:8px}
.memory-meta .badge{display:inline-block;padding:2px 6px;border-radius:4px;background:#f4f4f5;margin-right:6px}
.memory-meta .badge.curated{background:#dcfce7;color:#166534}
.memory-actions{display:flex;gap:8px;align-items:center}
.memory-actions a{font-size:12px;color:#2563eb;text-decoration:none}
.memory-actions button{font-size:12px;background:none;border:none;color:#dc2626;cursor:pointer;padding:2px 6px}
.edit-form textarea{width:100%;min-height:80px;padding:8px;border:1px solid #d4d4d8;border-radius:6px;font:inherit;resize:vertical;margin-bottom:8px}
.edit-form select{padding:6px;border:1px solid #d4d4d8;border-radius:6px;font:inherit;margin-bottom:8px}
.edit-form .row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.btn{padding:6px 12px;border-radius:6px;border:1px solid transparent;font-size:13px;cursor:pointer;text-decoration:none;display:inline-block}
.btn-primary{background:#2563eb;color:#fff;border-color:#2563eb}
.btn-secondary{background:#fff;color:#27272a;border-color:#d4d4d8}
.btn-danger{background:#dc2626;color:#fff;border-color:#dc2626}
.confirm-box{background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:16px;margin-bottom:16px;max-width:600px}
.confirm-box blockquote{margin:8px 0;padding:8px;border-left:3px solid #d4d4d8;background:#f4f4f5;color:#3f3f46}
.flash{padding:10px 12px;border-radius:6px;margin-bottom:16px;font-size:13px}
.flash.success{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}
.flash.error{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
.header-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.header-bar h1{font-size:20px;margin:0}
.session-log{margin-top:32px;max-width:900px}
.session-log h3{font-size:16px;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid #e4e4e7}
.session-row{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #f4f4f5;font-size:12px;align-items:center}
.session-row .id{color:#71717a;min-width:180px;word-break:break-all}
.session-row .date{color:#71717a;min-width:140px}
.session-row .status{font-weight:600}
.session-row .status.unconsolidated{color:#b45309}
.session-row .status.consolidated{color:#166534}
.session-row .status.error{color:#991b1b}
.session-row .tokens{color:#71717a;min-width:60px}
.session-row .err{color:#991b1b;flex:1;word-break:break-word}
.empty{color:#71717a;font-size:13px;padding:16px 0}
.logout-form{display:inline}
.archived-toggle{margin-bottom:12px}
.archived-toggle a{font-size:13px;color:#2563eb;text-decoration:none}
.consolidate-form{margin-bottom:12px}
.no-projects{color:#71717a;padding:20px}`;

/* ───────── JSX Components ───────── */

const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => {
	return (
		<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>{title}</title>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: Global CSS is a static constant, not user content */}
				<style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />
			</head>
			<body>{children}</body>
		</html>
	);
};

const LoginPage: FC<{ error: string; redirect: string }> = ({ error, redirect }) => {
	return (
		<Layout title="Login — divmemory">
			<div style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f4f4f5">
				<div style="background:#fff;padding:32px;border-radius:12px;border:1px solid #e4e4e7;min-width:320px">
					<h2 style="margin:0 0 16px;font-size:18px">divmemory — Login</h2>
					{error && <div class="flash error">{error}</div>}
					<form method="post" action="/login">
						<input type="hidden" name="redirect" value={redirect} />
						<div style="margin-bottom:12px">
							<label
								htmlFor="web-password"
								style="display:block;font-size:13px;color:#52525b;margin-bottom:4px"
							>
								Password
							</label>
							<input
								id="web-password"
								type="password"
								name="password"
								style="width:100%;padding:8px;border:1px solid #d4d4d8;border-radius:6px"
								autofocus
							/>
						</div>
						<button type="submit" class="btn btn-primary" style="width:100%">
							Sign in
						</button>
					</form>
				</div>
			</div>
		</Layout>
	);
};

const Sidebar: FC<{
	allProjects: { id: string; name: string | null; sessionCount: number | null }[];
	currentProject: { id: string; name: string | null } | undefined;
	showArchived: boolean;
}> = ({ allProjects, currentProject, showArchived }) => {
	return (
		<nav class="sidebar">
			{allProjects.length === 0 ? (
				<p class="no-projects">No projects yet.</p>
			) : (
				<>
					<h2>Projects</h2>
					<ul>
						{allProjects.map((p) => {
							const isCurrent = currentProject?.id === p.id;
							const href = `/?project=${encodeURIComponent(p.id)}${showArchived ? "&archived=1" : ""}`;
							return (
								<li key={p.id}>
									<a href={href} class={isCurrent ? "current" : undefined}>
										{p.name || p.id} <span class="count">{p.sessionCount ?? 0}</span>
									</a>
								</li>
							);
						})}
					</ul>
				</>
			)}
		</nav>
	);
};

const MemoryCard: FC<{
	m: MemoryRow;
	pid: string;
	csrfValue: string;
	isEditing: boolean;
	isDeleteConfirming: boolean;
}> = ({ m, pid, csrfValue, isEditing, isDeleteConfirming }) => {
	const topic = m.topic || "general";
	const editHref = `/?project=${encodeURIComponent(pid)}&edit=${encodeURIComponent(m.id)}${m.status === "archived" ? "&archived=1" : ""}`;
	const deleteHref = `/?project=${encodeURIComponent(pid)}&delete=${encodeURIComponent(m.id)}${m.status === "archived" ? "&archived=1" : ""}`;

	if (isEditing) {
		return (
			<div class="memory-card editing">
				<form method="post" action="/" class="edit-form">
					<input type="hidden" name="_method" value="PATCH" />
					<input type="hidden" name="edit" value={m.id} />
					<input type="hidden" name="project" value={pid} />
					<input type="hidden" name="csrf_token" value={csrfValue} />
					<textarea name="content">{m.content || ""}</textarea>
					<div class="row">
						<select name="topic">
							{VALID_TOPICS.map((t) => (
								// biome-ignore lint/correctness/useJsxKeyInIterable: hono/jsx does not require keys like React
								<option value={t} selected={topic === t ? true : undefined}>
									{TOPIC_LABELS[t]}
								</option>
							))}
						</select>
						<button type="submit" class="btn btn-primary">
							Save
						</button>
						<a href={`/?project=${encodeURIComponent(pid)}`} class="btn btn-secondary">
							Cancel
						</a>
					</div>
				</form>
				<form method="post" action="/" style="display:inline;margin-left:8px">
					<input type="hidden" name="_method" value="DELETE" />
					<input type="hidden" name="delete" value={m.id} />
					<input type="hidden" name="project" value={pid} />
					<input type="hidden" name="csrf_token" value={csrfValue} />
					<button type="submit" class="btn btn-danger" style="font-size:12px">
						Delete
					</button>
				</form>
			</div>
		);
	}

	if (isDeleteConfirming) {
		return (
			<div class="confirm-box">
				<p>Delete this memory?</p>
				<blockquote>{m.content || ""}</blockquote>
				<form method="post" action="/">
					<input type="hidden" name="_method" value="DELETE" />
					<input type="hidden" name="delete" value={m.id} />
					<input type="hidden" name="confirm" value="true" />
					<input type="hidden" name="project" value={pid} />
					<input type="hidden" name="csrf_token" value={csrfValue} />
					<button type="submit" class="btn btn-danger">
						Confirm Delete
					</button>
					<a href={`/?project=${encodeURIComponent(pid)}`} class="btn btn-secondary">
						Cancel
					</a>
				</form>
			</div>
		);
	}

	const actions =
		m.status === "archived" ? (
			<form method="post" action="/" style="display:inline">
				<input type="hidden" name="_method" value="PATCH" />
				<input type="hidden" name="id" value={m.id} />
				<input type="hidden" name="status" value="active" />
				<input type="hidden" name="project" value={pid} />
				<input type="hidden" name="csrf_token" value={csrfValue} />
				<button type="submit" class="btn btn-secondary" style="font-size:12px">
					Restore
				</button>
			</form>
		) : (
			<div class="memory-actions">
				<a href={editHref}>Edit</a>
				<a href={deleteHref}>Delete</a>
			</div>
		);

	return (
		<div class="memory-card">
			<div class="memory-content">{m.content || ""}</div>
			<div class="memory-meta">
				<span class="badge">{topicLabel(topic)}</span>
				<span class="badge">{confidencePercent(m.confidence)}</span>
				{m.curated ? <span class="badge curated">Curated</span> : undefined}
			</div>
			{actions}
		</div>
	);
};

const TopicGroup: FC<{
	topic: string;
	memories: MemoryRow[];
	pid: string;
	csrfValue: string;
	editId: string | undefined;
	deleteId: string | undefined;
	isArchivedView: boolean;
}> = ({ topic, memories, pid, csrfValue, editId, deleteId, isArchivedView }) => {
	if (!memories.length) return null;
	return (
		<div class="topic-group">
			<h3>{TOPIC_LABELS[topic] || topic}</h3>
			{memories.map((m) => {
				const isEditing = m.id === editId && !isArchivedView;
				const isDeleting = m.id === deleteId && !isArchivedView;
				return (
					<MemoryCard
						key={m.id}
						m={m}
						pid={pid}
						csrfValue={csrfValue}
						isEditing={isEditing}
						isDeleteConfirming={isDeleting}
					/>
				);
			})}
		</div>
	);
};

const SessionLogComponent: FC<{ rows: SessionRow[] }> = ({ rows }) => {
	if (!rows.length) {
		return (
			<div class="session-log">
				<h3>Session Log</h3>
				<p class="empty">No sessions yet.</p>
			</div>
		);
	}
	return (
		<div class="session-log">
			<h3>Session Log</h3>
			{rows.map((r) => {
				const label = sessionStatusLabel(r);
				const statusClass =
					r.consolidated === -1
						? "error"
						: r.consolidated === 0
							? "unconsolidated"
							: "consolidated";
				return (
					// biome-ignore lint/correctness/useJsxKeyInIterable: hono/jsx does not require keys like React
					<div class="session-row">
						<span class="id">{r.id}</span>
						<span class="date">{r.createdAt ?? ""}</span>
						<span class={`status ${statusClass}`}>{label}</span>
						<span class="tokens">{r.tokenCount ?? 0} tokens</span>
						{r.extractionError ? <span class="err">{r.extractionError}</span> : undefined}
					</div>
				);
			})}
		</div>
	);
};

const Flash: FC<{ success: string; error: string }> = ({ success, error }) => {
	if (success) return <div class="flash success">{success}</div>;
	if (error) return <div class="flash error">{error}</div>;
	return null;
};

const MainPage: FC<{
	allProjects: { id: string; name: string | null; sessionCount: number | null }[];
	currentProject: { id: string; name: string | null; sessionCount?: number | null } | undefined;
	memRows: MemoryRow[];
	sessionRows: SessionRow[];
	unconsolidatedCount: number;
	editId: string | undefined;
	deleteId: string | undefined;
	showArchived: boolean;
	csrfValue: string;
	success: string;
	error: string;
}> = ({
	allProjects,
	currentProject,
	memRows,
	sessionRows,
	unconsolidatedCount,
	editId,
	deleteId,
	showArchived,
	csrfValue,
	success,
	error,
}) => {
	const title = currentProject
		? `${currentProject.name || currentProject.id} — divmemory`
		: "divmemory";

	let main: ReturnType<FC>;
	if (!currentProject) {
		main = (
			<div class="main">
				<div class="memories">
					<h1>divmemory</h1>
					<p class="empty">Select a project from the sidebar, or create one via the API.</p>
				</div>
			</div>
		);
	} else {
		const pid = currentProject.id;
		const isNonexistent = !allProjects.some((p) => p.id === pid);
		if (isNonexistent) {
			main = (
				<div class="main">
					<div class="memories">
						<h1>{currentProject.name || pid}</h1>
						<div class="flash error">Project not found</div>
					</div>
				</div>
			);
		} else {
			const grouped: Record<string, MemoryRow[]> = {};
			for (const t of TOPIC_ORDER) grouped[t] = [];
			for (const m of memRows) {
				const t = m.topic || "general";
				if (!grouped[t]) grouped[t] = [];
				grouped[t].push(m);
			}

			const topicFrags = TOPIC_ORDER.map((t) => (
				// biome-ignore lint/correctness/useJsxKeyInIterable: hono/jsx does not require keys like React
				<TopicGroup
					topic={t}
					memories={grouped[t]}
					pid={pid}
					csrfValue={csrfValue}
					editId={editId}
					deleteId={deleteId}
					isArchivedView={showArchived}
				/>
			));

			const archivedToggle = showArchived ? (
				<div class="archived-toggle">
					<a href={`/?project=${encodeURIComponent(pid)}`}>Hide Archived</a>
				</div>
			) : (
				<div class="archived-toggle">
					<a href={`/?project=${encodeURIComponent(pid)}&archived=1`}>Show Archived</a>
				</div>
			);

			const consolidateFrag =
				unconsolidatedCount >= 2 && !showArchived ? (
					<form method="post" action="/" class="consolidate-form">
						<input type="hidden" name="action" value="consolidate" />
						<input type="hidden" name="project" value={pid} />
						<input type="hidden" name="csrf_token" value={csrfValue} />
						<button type="submit" class="btn btn-primary">
							Consolidate ({unconsolidatedCount} pending)
						</button>
					</form>
				) : null;

			const memoriesFrag =
				memRows.length > 0 ? (
					topicFrags
				) : (
					<p class="empty">No {showArchived ? "archived" : "active"} memories for this project.</p>
				);

			main = (
				<div class="main">
					<div class="memories">
						<div class="header-bar">
							<h1>{currentProject.name || pid}</h1>
							<form method="post" action="/logout" class="logout-form">
								<input type="hidden" name="csrf_token" value={csrfValue} />
								<button type="submit" class="btn btn-secondary">
									Logout
								</button>
							</form>
						</div>
						<Flash success={success} error={error} />
						{archivedToggle}
						{consolidateFrag}
						{memoriesFrag}
						<SessionLogComponent rows={sessionRows} />
					</div>
				</div>
			);
		}
	}

	return (
		<Layout title={title}>
			<div class="container">
				<Sidebar
					allProjects={allProjects}
					currentProject={currentProject}
					showArchived={showArchived}
				/>
				{main}
			</div>
		</Layout>
	);
};

/* ───────── route ───────── */

export function createWebUiRoute(
	// biome-ignore lint/suspicious/noExplicitAny: Hono generic typing too restrictive
	app: any,
	db?: DbLike,
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
		const success = c.req.query("success") || "";
		const error = c.req.query("error") || "";

		// Fetch all projects for sidebar
		const allProjectsRaw = (await dbCtx.select().from(projects).all()) as {
			id: string;
			name: string | null;
			sessionCount: number | null;
			lastSeen: string | null;
		}[];
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
		let queriedProjectId: string | undefined;

		if (currentProject) {
			queriedProjectId = currentProject.id;
			memRows = (await dbCtx
				.select()
				.from(memories)
				.where(
					and(
						eq(memories.projectId, queriedProjectId),
						eq(memories.status, showArchived ? "archived" : "active"),
					),
				)
				.orderBy(desc(memories.updatedAt))
				.all()) as unknown as MemoryRow[];

			sessionRows = (await dbCtx
				.select()
				.from(sessions)
				.where(eq(sessions.projectId, queriedProjectId))
				.orderBy(desc(sessions.createdAt))
				.limit(20)
				.all()) as unknown as SessionRow[];

			const ucResult = (await dbCtx
				.select({ count: sql<number>`count(*)` })
				.from(sessions)
				.where(and(eq(sessions.projectId, queriedProjectId), eq(sessions.consolidated, 0)))
				.get()) as { count: number } | undefined;
			unconsolidatedCount = ucResult?.count ?? 0;

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
			const existing = (await dbCtx
				.select()
				.from(memories)
				.where(eq(memories.id, memId))
				.get()) as unknown as MemoryRow | undefined;
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
			await dbCtx.update(memories).set(set).where(eq(memories.id, memId)).run();
			return c.redirect(`/?project=${encodeURIComponent(projectId)}&success=Memory+updated`, 302);
		}

		// Delete memory
		if (methodOverride === "DELETE" && body.delete) {
			const memId = String(body.delete);
			const row = (await dbCtx
				.select()
				.from(memories)
				.where(eq(memories.id, memId))
				.get()) as unknown as MemoryRow | undefined;
			if (!row) {
				return c.redirect(`/?project=${encodeURIComponent(projectId)}&error=Memory+not+found`, 302);
			}
			if (row.curated === 1) {
				await dbCtx
					.update(memories)
					.set({ status: "archived", updatedAt: new Date().toISOString() })
					.where(eq(memories.id, memId))
					.run();
			} else {
				await dbCtx.delete(memories).where(eq(memories.id, memId)).run();
			}
			return c.redirect(`/?project=${encodeURIComponent(projectId)}&success=Memory+removed`, 302);
		}

		// Restore memory (PATCH + id + status=active)
		if (methodOverride === "PATCH" && body.id && body.status === "active") {
			const memId = String(body.id);
			await dbCtx
				.update(memories)
				.set({ status: "active", updatedAt: new Date().toISOString() })
				.where(eq(memories.id, memId))
				.run();
			return c.redirect(`/?project=${encodeURIComponent(projectId)}&success=Memory+restored`, 302);
		}

		return c.redirect(`/?project=${encodeURIComponent(projectId)}`, 302);
	});

	/* ── POST logout ── */
	app.post("/logout", auth, async (c: Context) => {
		deleteCookie(c, SESSION_COOKIE, { path: "/" });
		return c.redirect("/login", 302);
	});
}
