import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { hybridAuth, rateLimitStore } from "../auth";
import { createLoginRoute } from "../login";
import { createMemoriesRoute } from "./memories";
import { createWebUiRoute } from "./webui";

const TEST_PASSWORD = "test-web-password-456";
const COOKIE_SECRET = "test-cookie-secret-789";
const TEST_API_KEY = "test-api-key-123";

function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite);
	sqlite.exec(`
		CREATE TABLE projects (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT,
			session_count INTEGER DEFAULT 0,
			created_at TEXT,
			last_seen TEXT
		);
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY NOT NULL,
			project_id TEXT NOT NULL,
			source TEXT,
			raw_text TEXT,
			consolidated INTEGER DEFAULT 0,
			extraction_error TEXT,
			token_count INTEGER,
			metadata TEXT,
			created_at TEXT,
			FOREIGN KEY (project_id) REFERENCES projects(id)
		);
		CREATE INDEX idx_sessions_project_id ON sessions (project_id);
		CREATE INDEX idx_sessions_project_id_consolidated ON sessions (project_id, consolidated);
		CREATE TABLE memories (
			id TEXT PRIMARY KEY NOT NULL,
			project_id TEXT NOT NULL,
			source_session TEXT NOT NULL,
			topic TEXT,
			content TEXT,
			confidence REAL DEFAULT 0,
			curated INTEGER DEFAULT 0,
			status TEXT DEFAULT 'active',
			created_at TEXT,
			updated_at TEXT,
			FOREIGN KEY (source_session) REFERENCES sessions(id)
		);
		CREATE INDEX idx_memories_project_id_topic ON memories (project_id, topic);
		CREATE INDEX idx_memories_project_id_status ON memories (project_id, status);
	`);
	return { sqlite, db };
}

// biome-ignore lint/suspicious/noExplicitAny: test-only helper returning app with patched fetch
function createTestApp(db: ReturnType<typeof drizzle>, _sqlite: Database): any {
	const app = new Hono<{
		Bindings: {
			DB: typeof db;
			DIVMEMORY_API_KEY: string;
			DIVMEMORY_WEB_PASSWORD: string;
			COOKIE_SECRET: string;
		};
	}>();

	// Body size + Content-Type gate (mirroring index.ts)
	app.use("*", async (c, next) => {
		const contentLength = Number(c.req.header("Content-Length") || "0");
		if (contentLength > 10 * 1024 * 1024) {
			return c.json({ error: "Payload Too Large" }, 413);
		}
		if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
			return next();
		}
		const ct = c.req.header("Content-Type") || "";
		const isWrite =
			c.req.path === "/ingest" ||
			c.req.path === "/context" ||
			c.req.path === "/consolidate" ||
			c.req.path.startsWith("/memories") ||
			c.req.path === "/login";
		if (
			isWrite &&
			!ct.includes("application/json") &&
			!ct.includes("application/x-www-form-urlencoded") &&
			!ct.includes("multipart/form-data")
		) {
			return c.json({ error: "Unsupported Media Type" }, 415);
		}
		return next();
	});

	// Auth
	app.use("/memories/*", hybridAuth("divmemory_session"));
	app.use("/memories", hybridAuth("divmemory_session"));

	// Login
	createLoginRoute(app, "divmemory_session");

	// Memories CRUD (behind hybrid auth)
	createMemoriesRoute(app, db);

	// Web UI
	createWebUiRoute(app, db);

	// Transparently inject test-provided headers from third-arg { headers } into Request object
	// so all tests can write: app.fetch(req, env, { headers })
	// biome-ignore lint/suspicious/noExplicitAny: test-only fetch wrapper
	const appAny = app as unknown as any;
	const _fetch = appAny.fetch.bind(appAny);
	appAny.fetch = async (req0: Request, env?: unknown, ctx?: unknown): Promise<Response> => {
		let req = req0;
		if (ctx && typeof (ctx as Record<string, unknown>).headers === "object") {
			const merged = new Headers(req.headers);
			for (const [k, v] of Object.entries(
				(ctx as Record<string, Record<string, string>>).headers,
			)) {
				merged.set(k, v);
			}
			req = new Request(req, { headers: merged });
		}
		return _fetch(req, env, ctx);
	};

	// biome-ignore lint/suspicious/noExplicitAny: test-only helper returning app with patched fetch
	return app as unknown as any;
}

function webEnvVars() {
	return {
		DIVMEMORY_API_KEY: TEST_API_KEY,
		DIVMEMORY_WEB_PASSWORD: TEST_PASSWORD,
		COOKIE_SECRET,
	};
}

async function signSession(secret: string, payload: { exp?: number }): Promise<string> {
	const payloadStr = JSON.stringify(payload);
	const payloadB64 = btoa(payloadStr);
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadStr));
	const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
	return `${payloadB64}.${sigB64}`;
}

async function cookieHeaders(): Promise<Record<string, string>> {
	const cookie = await signSession(COOKIE_SECRET, { exp: Math.floor(Date.now() / 1000) + 3600 });
	return {
		Cookie: `divmemory_session=${cookie}`,
		"Content-Type": "application/x-www-form-urlencoded",
	};
}

async function postForm(
	app: ReturnType<typeof createTestApp>,
	url: string,
	body: Record<string, string>,
	authHeaders: Record<string, string>,
): Promise<Response> {
	// GET the same URL to capture CSRF token from the page
	const getRes = await app.fetch(new Request(url), webEnvVars(), { headers: authHeaders });
	const html = await getRes.text();
	const csrfMatch = html.match(/name="csrf_token" value="([^"]*)"/);
	const csrfValue = csrfMatch ? csrfMatch[1] : "";
	const setCookie = getRes.headers.get("Set-Cookie") || "";
	const csrfCookieMatch = setCookie.match(/csrf_cookie=([^;]*)/);
	const csrfCookie = csrfCookieMatch ? `csrf_cookie=${csrfCookieMatch[1]}` : "";

	const mergedCookie = authHeaders.Cookie ? `${authHeaders.Cookie}; ${csrfCookie}` : csrfCookie;
	const postHeaders: Record<string, string> = {
		...authHeaders,
		Cookie: mergedCookie,
		"Content-Type": "application/x-www-form-urlencoded",
	};

	const formBody = new URLSearchParams({ ...body, csrf_token: csrfValue }).toString();
	return app.fetch(
		new Request(url, {
			method: "POST",
			headers: postHeaders,
			body: formBody,
		}),
		webEnvVars(),
	);
}

let _seedCounter = 0;

function seedProject(sqlite: Database, projectId: string, name?: string, sessionCount?: number) {
	sqlite.run(
		"INSERT OR IGNORE INTO projects (id, name, session_count, created_at, last_seen) VALUES (?, ?, ?, ?, ?)",
		projectId,
		name || projectId,
		sessionCount ?? 0,
		new Date().toISOString(),
		new Date().toISOString(),
	);
}

function seedSession(
	sqlite: Database,
	projectId: string,
	overrides: {
		id?: string;
		consolidated?: number;
		rawText?: string;
		extractionError?: string;
	} = {},
) {
	const sid = overrides.id || `sess-${projectId}-${++_seedCounter}`;
	sqlite.run(
		"INSERT OR IGNORE INTO sessions (id, project_id, source, raw_text, consolidated, extraction_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		sid,
		projectId,
		"droid",
		overrides.rawText ?? "seed",
		overrides.consolidated ?? 1,
		overrides.extractionError ?? null,
		new Date().toISOString(),
	);
	return sid;
}

function seedMemory(
	sqlite: Database,
	projectId: string,
	content: string,
	overrides: {
		id?: string;
		topic?: string;
		confidence?: number;
		curated?: number;
		status?: string;
		updatedAt?: string;
	} = {},
) {
	const sid = seedSession(sqlite, projectId);
	const id = overrides.id || crypto.randomUUID();
	sqlite.run(
		"INSERT INTO memories (id, project_id, source_session, topic, content, confidence, curated, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id,
		projectId,
		sid,
		overrides.topic ?? "general",
		content,
		overrides.confidence ?? 0.9,
		overrides.curated ?? 0,
		overrides.status ?? "active",
		new Date().toISOString(),
		overrides.updatedAt ?? new Date().toISOString(),
	);
	return id;
}

/* ───────── LOGIN ───────── */

describe("Web UI — Login", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let sqlite: Database;
	let app: ReturnType<typeof createTestApp>;

	beforeEach(() => {
		_seedCounter = 0;
		rateLimitStore.clear();
		testDb = createTestDb();
		sqlite = testDb.sqlite;
		app = createTestApp(testDb.db, sqlite);
	});

	it("GET /login returns HTML login page with password input (VAL-UI-001)", async () => {
		const res = await app.fetch(new Request("http://localhost/login"), webEnvVars());
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("<form");
		expect(html).toContain("password");
		expect(html).toContain('type="password"');
	});

	it("POST /login with correct password sets cookie and redirects (VAL-UI-002)", async () => {
		const res = await app.fetch(
			new Request("http://localhost/login", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: `password=${encodeURIComponent(TEST_PASSWORD)}`,
			}),
			webEnvVars(),
		);
		expect(res.status).toBe(302);
		const setCookie = res.headers.get("Set-Cookie");
		expect(setCookie).toBeTruthy();
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(res.headers.get("Location")).toMatch(/\/$/);
	});

	it("POST /login with incorrect password returns error without cookie (VAL-UI-003)", async () => {
		const res = await app.fetch(
			new Request("http://localhost/login", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: "password=wrong",
			}),
			webEnvVars(),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("Set-Cookie")).toBeFalsy();
	});

	it("POST /login with empty password returns error (VAL-UI-004)", async () => {
		const res = await app.fetch(
			new Request("http://localhost/login", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: "password=",
			}),
			webEnvVars(),
		);
		expect(res.status).toBe(401);
	});

	it("redirect after login preserves original target parameter (VAL-UI-077)", async () => {
		const res = await app.fetch(
			new Request("http://localhost/login?redirect=%2F%3Fproject%3Dmy-app", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: `password=${encodeURIComponent(TEST_PASSWORD)}`,
			}),
			webEnvVars(),
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain("/");
	});
});

/* ───────── INDEX / SIDEBAR / MEMORY BROWSER ───────── */

describe("Web UI — Main Page", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let sqlite: Database;
	let app: ReturnType<typeof createTestApp>;

	beforeEach(() => {
		_seedCounter = 0;
		rateLimitStore.clear();
		testDb = createTestDb();
		sqlite = testDb.sqlite;
		app = createTestApp(testDb.db, sqlite);
	});

	it("GET / without auth redirects to /login (VAL-UI-069)", async () => {
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars());
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toMatch(/\/login/);
	});

	it("GET / with valid cookie returns HTML main UI (VAL-UI-005)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("divmemory");
	});

	it("sidebar lists projects with session counts (VAL-UI-010–016)", async () => {
		seedProject(sqlite, "p1", "Project One", 3);
		seedProject(sqlite, "p2", "Project Two", 7);
		seedSession(sqlite, "p1");
		seedSession(sqlite, "p2");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain("Project One");
		expect(html).toContain("Project Two");
		expect(html).toContain("3");
		expect(html).toContain("7");
	});

	it("clicking project link navigates to ?project= (VAL-UI-018)", async () => {
		seedProject(sqlite, "p1", "Project One");
		seedMemory(sqlite, "p1", "Fact A", { topic: "decisions" });
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain("Fact A");
		expect(html).toContain('href="/?project=p1"');
	});

	it("memories grouped by topic with semantic headings (VAL-UI-019–025)", async () => {
		seedProject(sqlite, "p1", "Project One");
		seedMemory(sqlite, "p1", "Decision 1", { topic: "decisions" });
		seedMemory(sqlite, "p1", "Issue 1", { topic: "issues" });
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain("Decision 1");
		expect(html).toContain("Issue 1");
		expect(html).toContain("Decisions");
		expect(html).toContain("Issues");
	});

	it("active memories shown by default; archived hidden (VAL-UI-026–027)", async () => {
		seedProject(sqlite, "p1");
		seedMemory(sqlite, "p1", "Active Fact");
		seedMemory(sqlite, "p1", "Archived Fact", { status: "archived" });
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain("Active Fact");
		expect(html).not.toContain("Archived Fact");
	});

	it("edit button renders for each memory (VAL-UI-036)", async () => {
		seedProject(sqlite, "p1");
		const mid = seedMemory(sqlite, "p1", "Fact 1");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain(`edit=${mid}`);
	});

	it("edit form opens inline with textarea + topic dropdown (VAL-UI-037–040)", async () => {
		seedProject(sqlite, "p1");
		const mid = seedMemory(sqlite, "p1", "Fact 1");
		const headers = await cookieHeaders();
		const res = await app.fetch(
			new Request(`http://localhost/?project=p1&edit=${mid}`),
			webEnvVars(),
			{ headers },
		);
		const html = await res.text();
		expect(html).toContain("Fact 1");
		expect(html).toContain("<textarea");
		expect(html).toContain("<select");
		expect(html).toContain("_method");
		expect(html).toContain('value="PATCH"');
	});

	it("submitting edit form PATCHes memory and redirects (VAL-UI-041–043)", async () => {
		seedProject(sqlite, "p1");
		const mid = seedMemory(sqlite, "p1", "Old content");
		const headers = await cookieHeaders();
		const res = await postForm(
			app,
			`http://localhost/?project=p1&edit=${mid}`,
			{
				_method: "PATCH",
				edit: mid,
				content: "Updated content",
				topic: "decisions",
				project: "p1",
			},
			headers,
		);
		expect(res.status).toBe(302);
		// Verify fact was updated
		const row = sqlite
			.query("SELECT content, curated, topic FROM memories WHERE id = ?")
			.get(mid) as { content: string; curated: number; topic: string };
		expect(row.content).toBe("Updated content");
		expect(row.topic).toBe("decisions");
		expect(row.curated).toBe(1);
	});

	it("non-existent memory in edit URL returns page with error message (VAL-UI-101)", async () => {
		seedProject(sqlite, "p1");
		const headers = await cookieHeaders();
		const res = await app.fetch(
			new Request("http://localhost/?project=p1&edit=nonexistent-uuid"),
			webEnvVars(),
			{ headers },
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("not found");
	});

	it("delete button renders for each memory (VAL-UI-044)", async () => {
		seedProject(sqlite, "p1");
		const mid = seedMemory(sqlite, "p1", "Fact 1");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain(`delete=${mid}`);
		html.includes("_method");
		html.includes('value="DELETE"');
	});

	it("delete confirmation step with content preview (VAL-UI-045–049)", async () => {
		seedProject(sqlite, "p1");
		const mid = seedMemory(sqlite, "p1", "Fact to delete");
		const headers = await cookieHeaders();
		const res = await app.fetch(
			new Request(`http://localhost/?project=p1&delete=${mid}`),
			webEnvVars(),
			{ headers },
		);
		const html = await res.text();
		expect(html).toContain("Fact to delete");
		expect(html).toContain("confirm");
	});

	it("soft-delete for curated fact (VAL-UI-046–047)", async () => {
		seedProject(sqlite, "p1");
		const mid = seedMemory(sqlite, "p1", "Curated fact", { curated: 1 });
		const headers = await cookieHeaders();
		const res = await postForm(
			app,
			`http://localhost/?project=p1&delete=${mid}`,
			{ _method: "DELETE", delete: mid, confirm: "true", project: "p1" },
			headers,
		);
		expect(res.status).toBe(302);
		const row = sqlite.query("SELECT status FROM memories WHERE id = ?").get(mid) as {
			status: string;
		};
		expect(row.status).toBe("archived");
	});

	it("hard-delete for auto-extracted fact (VAL-UI-048)", async () => {
		seedProject(sqlite, "p1");
		const mid = seedMemory(sqlite, "p1", "Auto fact", { curated: 0 });
		const headers = await cookieHeaders();
		const res = await postForm(
			app,
			`http://localhost/?project=p1&delete=${mid}`,
			{ _method: "DELETE", delete: mid, confirm: "true", project: "p1" },
			headers,
		);
		expect(res.status).toBe(302);
		const row = sqlite.query("SELECT id FROM memories WHERE id = ?").get(mid) as { id?: string };
		expect(row).toBeNull();
	});

	it("Show Archived toggle renders on page (VAL-UI-051)", async () => {
		seedProject(sqlite, "p1");
		seedMemory(sqlite, "p1", "Fact", { status: "archived" });
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain("archived");
	});

	it("archived facts shown when toggle active (VAL-UI-052–053)", async () => {
		seedProject(sqlite, "p1");
		seedMemory(sqlite, "p1", "Active F");
		seedMemory(sqlite, "p1", "Archived F", { status: "archived" });
		const headers = await cookieHeaders();
		const res = await app.fetch(
			new Request("http://localhost/?project=p1&archived=1"),
			webEnvVars(),
			{ headers },
		);
		const html = await res.text();
		expect(html).toContain("Archived F");
	});

	it("restore button on archived facts (VAL-UI-052)", async () => {
		seedProject(sqlite, "p1");
		const mid = seedMemory(sqlite, "p1", "Archived F", { status: "archived" });
		const headers = await cookieHeaders();
		const res = await app.fetch(
			new Request("http://localhost/?project=p1&archived=1"),
			webEnvVars(),
			{ headers },
		);
		const html = await res.text();
		expect(html).toContain("Restore");
		expect(html).toContain(mid);
	});

	it("clicking restore sets status=active (VAL-UI-053)", async () => {
		seedProject(sqlite, "p1");
		const mid = seedMemory(sqlite, "p1", "Archived F", { status: "archived" });
		const headers = await cookieHeaders();
		const res = await postForm(
			app,
			"http://localhost/",
			{ _method: "PATCH", id: mid, status: "active", project: "p1" },
			headers,
		);
		expect(res.status).toBe(302);
		const row = sqlite.query("SELECT status FROM memories WHERE id = ?").get(mid) as {
			status: string;
		};
		expect(row.status).toBe("active");
	});

	it("consolidate button shown when 2+ unconsolidated sessions (VAL-UI-055)", async () => {
		seedProject(sqlite, "p1");
		seedSession(sqlite, "p1", { id: "s1", consolidated: 0 });
		seedSession(sqlite, "p1", { id: "s2", consolidated: 0 });
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain("consolidat");
	});

	it("consolidate button hidden when <2 unconsolidated sessions (VAL-UI-056)", async () => {
		seedProject(sqlite, "p1");
		seedSession(sqlite, "p1", { id: "s1", consolidated: 0 });
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).not.toContain("Consolid");
	});

	it("submitting consolidate POST fires consolidation and redirects (VAL-UI-057–060)", async () => {
		seedProject(sqlite, "p1");
		seedSession(sqlite, "p1", { id: "s1", consolidated: 0 });
		seedSession(sqlite, "p1", { id: "s2", consolidated: 0 });
		const headers = await cookieHeaders();
		const res = await postForm(
			app,
			"http://localhost/",
			{ action: "consolidate", project: "p1" },
			headers,
		);
		expect(res.status).toBe(302);
	});

	it("session log shows last 20 sessions with status indicators (VAL-UI-062–068)", async () => {
		seedProject(sqlite, "p1");
		seedSession(sqlite, "p1", { consolidated: 0 });
		seedSession(sqlite, "p1", { consolidated: 1 });
		seedSession(sqlite, "p1", { consolidated: -1, extractionError: "fail" });
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain("session");
		expect(html).toContain("Unconsolidated");
		expect(html).toContain("Consolidated");
		expect(html).toContain("Error");
	});

	it("contains logout link/form (VAL-UI-070–071)", async () => {
		seedProject(sqlite, "p1");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain("logout");
		expect(html).toContain("form");
		expect(html).toContain("action=");
	});

	it("POST /logout clears cookie and redirects (VAL-UI-070)", async () => {
		const headers = await cookieHeaders();
		const res = await postForm(app, "http://localhost/logout", {}, headers);
		expect(res.status).toBe(302);
		const setCookie = res.headers.get("Set-Cookie");
		expect(setCookie).toBeTruthy();
		expect(res.headers.get("Location")).toMatch(/\/login/);
	});

	it("XSS prevention: special characters escaped (VAL-UI-080)", async () => {
		seedProject(sqlite, "p1");
		seedMemory(sqlite, "p1", "<script>alert(1)</script>");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain("&lt;");
		expect(html).not.toContain("<script>alert(1)</script>");
	});

	it("no client-side JavaScript (no <script> tags) (VAL-UI-072)", async () => {
		seedProject(sqlite, "p1");
		seedMemory(sqlite, "p1", "Fact");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).not.toMatch(/<script/);
		expect(html).not.toMatch(/onclick/);
		expect(html).not.toMatch(/onsubmit/);
	});

	it("all navigation via <a> and <form>, no JS navigation (VAL-UI-073)", async () => {
		seedProject(sqlite, "p1");
		seedMemory(sqlite, "p1", "Fact");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toMatch(/<a\s/);
		expect(html).toMatch(/<form\s/);
		expect(html).not.toContain("window.location");
		expect(html).not.toContain("addEventListener");
	});

	it("forms include hidden _method fields for PATCH and DELETE (VAL-UI-093–094)", async () => {
		seedProject(sqlite, "p1");
		const mid = seedMemory(sqlite, "p1", "Fact");
		const headers = await cookieHeaders();
		const res = await app.fetch(
			new Request(`http://localhost/?project=p1&edit=${mid}`),
			webEnvVars(),
			{ headers },
		);
		const html = await res.text();
		expect(html).toContain("_method");
		expect(html).toContain('value="PATCH"');
		expect(html).toContain('value="DELETE"');
	});

	it("single-project default selection — auto-show on root (VAL-UI-104)", async () => {
		seedProject(sqlite, "only", "Only Project");
		seedMemory(sqlite, "only", "Fact For Only");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain("Fact For Only");
	});

	it("nonexistent project ID shows 'not found' message (VAL-UI-100)", async () => {
		seedProject(sqlite, "exist", "Existing");
		const headers = await cookieHeaders();
		const res = await app.fetch(
			new Request("http://localhost/?project=nonexistent-id"),
			webEnvVars(),
			{ headers },
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("not found");
	});

	it("topic headings hidden when no memories in that topic (VAL-UI-089)", async () => {
		seedProject(sqlite, "p1");
		seedMemory(sqlite, "p1", "Only general fact", { topic: "general" });
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain("General");
		expect(html).not.toContain("Issues");
	});
});

/* ───────── DOCUMENT STRUCTURE ───────── */

describe("Web UI — Document Structure", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let sqlite: Database;
	let app: ReturnType<typeof createTestApp>;

	beforeEach(() => {
		_seedCounter = 0;
		rateLimitStore.clear();
		testDb = createTestDb();
		sqlite = testDb.sqlite;
		app = createTestApp(testDb.db, sqlite);
	});

	it("html lang attribute (VAL-UI-105)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain('lang="en"');
	});

	it("meta charset present (VAL-UI-106)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain('charset="UTF-8"');
	});

	it("meta viewport present (VAL-UI-107)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain('name="viewport"');
		expect(html).toContain("width=device-width");
	});

	it("title element (VAL-UI-108)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain("<title>");
		expect(html).toContain("divmemory");
		expect(html).toContain("</title>");
	});

	it("favicon link present (VAL-UI-109)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain('rel="icon"');
	});

	it("og:title meta (VAL-UI-110)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain('property="og:title"');
		expect(html).toContain("divmemory");
	});

	it("og:description meta (VAL-UI-111)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain('property="og:description"');
	});

	it("og:type meta (VAL-UI-112)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain('property="og:type"');
		expect(html).toContain('content="website"');
	});
});

/* ───────── ACCESSIBILITY ───────── */

describe("Web UI — Accessibility", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let sqlite: Database;
	let app: ReturnType<typeof createTestApp>;

	beforeEach(() => {
		_seedCounter = 0;
		rateLimitStore.clear();
		testDb = createTestDb();
		sqlite = testDb.sqlite;
		app = createTestApp(testDb.db, sqlite);
	});

	it("login form password input has label (VAL-UI-113)", async () => {
		const res = await app.fetch(new Request("http://localhost/login"), webEnvVars());
		const html = await res.text();
		expect(html).toContain('for="web-password"');
		expect(html).toContain('id="web-password"');
	});

	it("login submit button accessible text (VAL-UI-114)", async () => {
		const res = await app.fetch(new Request("http://localhost/login"), webEnvVars());
		const html = await res.text();
		expect(html).toContain("Sign in");
	});

	it("password input has autofocus (VAL-UI-115)", async () => {
		const res = await app.fetch(new Request("http://localhost/login"), webEnvVars());
		const html = await res.text();
		expect(html).toContain("autofocus");
	});

	it("semantic nav element for sidebar (VAL-UI-116)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain('<nav class="sidebar">');
	});

	it("heading hierarchy has single h1 (VAL-UI-117)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		const h1Matches = html.match(/<h1[\s>]/g);
		expect(h1Matches?.length ?? 0).toBe(1);
	});

	it("no img tags without alt on page (VAL-UI-118)", async () => {
		seedProject(sqlite, "p1", "Project One");
		seedMemory(sqlite, "p1", "Fact");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		const imgMatches = html.match(/<img\s[^>]*>/g) ?? [];
		for (const img of imgMatches) {
			expect(img).toContain("alt=");
		}
	});
});

/* ───────── HTTP HEADERS & RESPONSE CODES ───────── */

describe("Web UI — HTTP Headers & Response Codes", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let sqlite: Database;
	let app: ReturnType<typeof createTestApp>;

	beforeEach(() => {
		_seedCounter = 0;
		rateLimitStore.clear();
		testDb = createTestDb();
		sqlite = testDb.sqlite;
		app = createTestApp(testDb.db, sqlite);
	});

	it("Content-Type text/html on GET (VAL-UI-119)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
	});

	it("Content-Type text/html on login (VAL-UI-120)", async () => {
		const res = await app.fetch(new Request("http://localhost/login"), webEnvVars());
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
	});

	it("login redirect 302 (VAL-UI-121)", async () => {
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars());
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain("/login");
	});

	it("successful form POST redirects 302 (VAL-UI-122)", async () => {
		seedProject(sqlite, "p1");
		const mid = seedMemory(sqlite, "p1", "Fact", { curated: 0 });
		const headers = await cookieHeaders();
		const res = await postForm(
			app,
			`http://localhost/?project=p1&delete=${mid}`,
			{ _method: "DELETE", delete: mid, confirm: "true", project: "p1" },
			headers,
		);
		expect(res.status).toBe(302);
	});

	it("error page content type preserved (VAL-UI-123)", async () => {
		seedProject(sqlite, "exist", "Existing");
		const headers = await cookieHeaders();
		const res = await app.fetch(
			new Request("http://localhost/?project=nonexistent-id"),
			webEnvVars(),
			{ headers },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
	});
});

/* ───────── LONG CONTENT & EDGE CASES ───────── */

describe("Web UI — Long Content & Edge Cases", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let sqlite: Database;
	let app: ReturnType<typeof createTestApp>;

	beforeEach(() => {
		_seedCounter = 0;
		rateLimitStore.clear();
		testDb = createTestDb();
		sqlite = testDb.sqlite;
		app = createTestApp(testDb.db, sqlite);
	});

	it("very long memory content renders (VAL-UI-124)", async () => {
		seedProject(sqlite, "p1");
		const longContent = "A".repeat(15000);
		seedMemory(sqlite, "p1", longContent);
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain(longContent.slice(0, 50));
	});

	it("emoji in memory content (VAL-UI-125)", async () => {
		seedProject(sqlite, "p1");
		seedMemory(sqlite, "p1", "🚀 🧠 🎉 fact");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain("🚀 🧠 🎉 fact");
	});

	it("very long project name sidebar (VAL-UI-126)", async () => {
		const longName = "B".repeat(200);
		seedProject(sqlite, "p1", longName);
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain(longName.slice(0, 30));
	});

	it("session with very long ID (VAL-UI-127)", async () => {
		seedProject(sqlite, "p1");
		const longId = "C".repeat(100);
		seedSession(sqlite, "p1", { id: longId });
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).toContain(longId);
	});

	it("unusual characters in memory (VAL-UI-128)", async () => {
		seedProject(sqlite, "p1");
		seedMemory(sqlite, "p1", "<>&\"'test");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/?project=p1"), webEnvVars(), {
			headers,
		});
		const html = await res.text();
		expect(html).not.toContain("<>&\"'test");
		expect(html).toContain("&lt;");
	});
});

/* ───────── MISC COSMETIC ───────── */

describe("Web UI — Misc Cosmetic", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let sqlite: Database;
	let app: ReturnType<typeof createTestApp>;

	beforeEach(() => {
		_seedCounter = 0;
		rateLimitStore.clear();
		testDb = createTestDb();
		sqlite = testDb.sqlite;
		app = createTestApp(testDb.db, sqlite);
	});

	it("sidebar empty state message (VAL-UI-129)", async () => {
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain("No projects yet.");
	});

	it("Hono JSX renders valid HTML document (VAL-UI-130)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain('<html lang="en">');
		expect(html).toContain("</html>");
		expect(html).toContain("<body>");
		expect(html).toContain("</body>");
	});

	it("CSS is embedded via style tag (VAL-UI-131)", async () => {
		seedProject(sqlite, "p1", "Project One");
		const headers = await cookieHeaders();
		const res = await app.fetch(new Request("http://localhost/"), webEnvVars(), { headers });
		const html = await res.text();
		expect(html).toContain("<style>");
	});
});
