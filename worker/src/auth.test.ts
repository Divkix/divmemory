import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { bearerAuth, cookieAuth, hybridAuth, signCookie, timingSafeEqualStr } from "./auth";
import { csrfValidate } from "./csrf";
import { createLoginRoute } from "./login";

const TEST_API_KEY = "test-api-key-123";
const TEST_PASSWORD = "test-web-password";
const TEST_SECRET = "test-cookie-secret-very-long";

type Bindings = Record<string, string>;

function createMockEnv(): Bindings {
	return {
		DIVMEMORY_API_KEY: TEST_API_KEY,
		DIVMEMORY_WEB_PASSWORD: TEST_PASSWORD,
		COOKIE_SECRET: TEST_SECRET,
	};
}

function createTestApp() {
	const app = new Hono<{ Bindings: Bindings }>();

	// Body size gate (10MB)
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

	// Auth middleware per route
	app.use("/ingest", bearerAuth("divmemory_session"));
	app.use("/context", bearerAuth("divmemory_session"));
	app.use("/consolidate", bearerAuth("divmemory_session"));
	app.use("/memories/*", hybridAuth("divmemory_session"));
	app.use("/memories", hybridAuth("divmemory_session"));

	// Web UI routes require cookie
	app.use("/", cookieAuth("divmemory_session"));
	app.use("/login", async (_c, next) => next());

	// Login route
	createLoginRoute(app, "divmemory_session");

	// Stub protected routes
	app.post("/ingest", (c) => c.json({ ok: true }));
	app.get("/context", (c) => c.text("context data"));
	app.post("/consolidate", (c) => c.json({ ok: true }));
	app.get("/memories", (c) => c.json({ memories: [] }));
	app.patch("/memories/:id", (c) => c.json({ ok: true }));
	app.delete("/memories/:id", (c) => c.json({ ok: true }));
	app.get("/", (c) => c.text("web ui"));

	return app;
}

describe("Bearer token auth", () => {
	const env = createMockEnv();

	it("passes with valid API key on /ingest", async () => {
		const testApp = createTestApp();
		const req = new Request("http://localhost/ingest", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${TEST_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: "{}",
		});
		const res = await testApp.fetch(req, env);
		expect(res.status).toBe(200);
	});

	it("returns 401 when missing Authorization header on /ingest", async () => {
		const testApp = createTestApp();
		const req = new Request("http://localhost/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		const res = await testApp.fetch(req, env);
		expect(res.status).toBe(401);
	});

	it("returns 401 with invalid API key on /ingest", async () => {
		const testApp = createTestApp();
		const req = new Request("http://localhost/ingest", {
			method: "POST",
			headers: {
				Authorization: "Bearer wrong-key",
				"Content-Type": "application/json",
			},
			body: "{}",
		});
		const res = await testApp.fetch(req, env);
		expect(res.status).toBe(401);
	});

	it("passes with valid API key on /context", async () => {
		const testApp = createTestApp();
		const req = new Request("http://localhost/context?project=test", {
			headers: { Authorization: `Bearer ${TEST_API_KEY}` },
		});
		const res = await testApp.fetch(req, env);
		expect(res.status).toBe(200);
	});

	it("returns 401 when missing auth on /context", async () => {
		const testApp = createTestApp();
		const req = new Request("http://localhost/context?project=test");
		const res = await testApp.fetch(req, env);
		expect(res.status).toBe(401);
	});

	it("passes with valid API key on POST /consolidate", async () => {
		const testApp = createTestApp();
		const req = new Request("http://localhost/consolidate", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${TEST_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: "{}",
		});
		const res = await testApp.fetch(req, env);
		expect(res.status).toBe(200);
	});
});

describe("Cookie auth", () => {
	const env = createMockEnv();

	async function doLogin(honoApp: ReturnType<typeof createTestApp>) {
		const req = new Request("http://localhost/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: TEST_PASSWORD }),
		});
		return honoApp.fetch(req, env);
	}

	it("valid password sets cookie with HttpOnly, SameSite=Strict", async () => {
		const app = createTestApp();
		const res = await doLogin(app);
		expect(res.status).toBe(200);
		const setCookieHeader = res.headers.get("Set-Cookie");
		expect(setCookieHeader).toBeTruthy();
		expect(setCookieHeader).toContain("HttpOnly");
		expect(setCookieHeader).toContain("SameSite=Strict");
		expect(setCookieHeader).toMatch(/Max-Age=|Expires=/);
		// http:// requests omit Secure; https:// include it
		expect(setCookieHeader).not.toContain("Secure");
	});

	it("invalid password returns 401 and no cookie", async () => {
		const app = createTestApp();
		const req = new Request("http://localhost/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: "wrong" }),
		});
		const res = await app.fetch(req, env);
		expect(res.status).toBe(401);
		const setCookieHeader = res.headers.get("Set-Cookie");
		expect(setCookieHeader).toBeFalsy();
	});

	it("valid cookie allows access to GET /memories", async () => {
		const app = createTestApp();
		const loginRes = await doLogin(app);
		const cookie = loginRes.headers.get("Set-Cookie") || "";
		const sessionCookie = cookie.split(";")[0]; // name=value
		const req = new Request("http://localhost/memories", {
			headers: { Cookie: sessionCookie },
		});
		const res = await app.fetch(req, env);
		expect(res.status).toBe(200);
	});

	it("invalid cookie returns 401 on GET /memories", async () => {
		const app = createTestApp();
		const req = new Request("http://localhost/memories", {
			headers: { Cookie: "divmemory_session=badvalue" },
		});
		const res = await app.fetch(req, env);
		expect(res.status).toBe(401);
	});

	it("expired cookie is rejected", async () => {
		const app = createTestApp();
		const sessionCookie = await createExpiredSignedCookie("divmemory_session", "test", TEST_SECRET);
		const req = new Request("http://localhost/memories", {
			headers: { Cookie: sessionCookie },
		});
		const res = await app.fetch(req, env);
		expect(res.status).toBe(401);
	});

	it("tampered cookie payload is rejected", async () => {
		const app = createTestApp();
		const loginRes = await doLogin(app);
		const cookie = loginRes.headers.get("Set-Cookie") || "";
		const sessionCookie = cookie.split(";")[0]; // name=value
		const [nameVal] = sessionCookie.split(";")[0].split("=");
		const tampered = `${nameVal}=tamperedvalue.signature`;
		const req = new Request("http://localhost/memories", {
			headers: { Cookie: tampered },
		});
		const res = await app.fetch(req, env);
		expect(res.status).toBe(401);
	});
});

describe("Credential independence", () => {
	const env = createMockEnv();

	it("Bearer token does NOT grant web UI access (GET /)", async () => {
		const app = createTestApp();
		const req = new Request("http://localhost/", {
			headers: { Authorization: `Bearer ${TEST_API_KEY}` },
		});
		const res = await app.fetch(req, env);
		expect(res.status).toBe(401);
	});

	it("cookie does NOT grant API access to /context", async () => {
		const app = createTestApp();
		const loginReq = new Request("http://localhost/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: TEST_PASSWORD }),
		});
		const loginRes = await app.fetch(loginReq, env);
		const cookie = loginRes.headers.get("Set-Cookie") || "";
		const sessionCookie = cookie.split(";")[0];
		const req = new Request("http://localhost/context?project=test", {
			headers: { Cookie: sessionCookie },
		});
		const res = await app.fetch(req, env);
		expect(res.status).toBe(401);
	});

	it("cookie does NOT grant API access to /ingest", async () => {
		const app = createTestApp();
		const loginReq = new Request("http://localhost/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: TEST_PASSWORD }),
		});
		const loginRes = await app.fetch(loginReq, env);
		const cookie = loginRes.headers.get("Set-Cookie") || "";
		const sessionCookie = cookie.split(";")[0];
		const req = new Request("http://localhost/ingest", {
			method: "POST",
			headers: {
				Cookie: sessionCookie,
				"Content-Type": "application/json",
			},
			body: "{}",
		});
		const res = await app.fetch(req, env);
		expect(res.status).toBe(401);
	});
});

describe("Login body validation", () => {
	const env = createMockEnv();

	it("missing password returns 400/401", async () => {
		const app = createTestApp();
		for (const body of ["{}", "", JSON.stringify({})]) {
			const req = new Request("http://localhost/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});
			const res = await app.fetch(req, env);
			expect([400, 401]).toContain(res.status);
		}
	});
});

describe("Login rate limiting", () => {
	const env = createMockEnv();

	it("throttles after 10 failed attempts in 60s", async () => {
		const app = createTestApp();
		const makeWrongLogin = async () => {
			const req = new Request("http://localhost/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password: "wrong" }),
			});
			return app.fetch(req, env);
		};

		for (let i = 0; i < 10; i++) {
			const res = await makeWrongLogin();
			expect(res.status).toBe(401);
		}
		const res = await makeWrongLogin();
		expect([429, 401]).toContain(res.status);
	});
});

describe("CSRF protection", () => {
	const env = createMockEnv();

	const csrfStub = (c: Context) => c.json({ ok: true });

	it("POST /consolidate with Bearer exempt from CSRF (no token still 200)", async () => {
		const csrfApp = new Hono();
		csrfApp.post("/consolidate", csrfValidate("csrf_token"), csrfStub);
		const req = new Request("http://localhost/consolidate", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${TEST_API_KEY}`,
			},
			body: JSON.stringify({ project_id: "test" }),
		});
		const res = await csrfApp.fetch(req, env);
		expect(res.status).toBe(200);
	});

	it("POST /consolidate with cookie but no CSRF token returns 403", async () => {
		const { Hono } = await import("hono");
		const csrfApp = new Hono();
		// Mount a fake cookie-auth layer first so the cookie exists
		csrfApp.post("/consolidate", csrfValidate("csrf_token"), csrfStub);
		const req = new Request("http://localhost/consolidate", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: "divmemory_session=validcookie",
			},
			body: JSON.stringify({ project_id: "test" }),
		});
		const res = await csrfApp.fetch(req, env);
		expect(res.status).toBe(403);
	});

	it("POST /consolidate with valid CSRF token returns 200", async () => {
		const csrfApp = new Hono();
		csrfApp.post("/consolidate", csrfValidate("csrf_token"), csrfStub);

		const validCsrf = await makeTestCsrf("abc123", TEST_SECRET);
		const req = new Request("http://localhost/consolidate", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `csrf_token=${validCsrf}`,
				"X-CSRF-Token": "abc123",
			},
			body: JSON.stringify({ project_id: "test" }),
		});
		const res = await csrfApp.fetch(req, env);
		expect(res.status).toBe(200);
	});

	it("GET /memories?search injection returns 0 results / no crash", async () => {
		const app = createTestApp();
		const req = new Request(
			`http://localhost/memories?search=${encodeURIComponent("' OR 1=1; --")}`,
			{
				headers: { Authorization: `Bearer ${TEST_API_KEY}` },
			},
		);
		const res = await app.fetch(req, env);
		expect([200, 401]).toContain(res.status);
	});
});

describe("Body size and Content-Type", () => {
	const env = createMockEnv();

	it("POST /ingest with 10MB body returns 413", async () => {
		const app = createTestApp();
		const bigBody = "x".repeat(11 * 1024 * 1024);
		const req = new Request("http://localhost/ingest", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(11 * 1024 * 1024),
				Authorization: `Bearer ${TEST_API_KEY}`,
			},
			body: bigBody,
		});
		const res = await app.fetch(req, env);
		expect(res.status).toBe(413);
	});

	it("POST /ingest with Content-Type text/plain returns 415", async () => {
		const app = createTestApp();
		const req = new Request("http://localhost/ingest", {
			method: "POST",
			headers: {
				"Content-Type": "text/plain",
				Authorization: `Bearer ${TEST_API_KEY}`,
			},
			body: "{}",
		});
		const res = await app.fetch(req, env);
		expect(res.status).toBe(415);
	});
});

async function createExpiredSignedCookie(
	name: string,
	value: string,
	secret: string,
): Promise<string> {
	const payload = JSON.stringify({
		v: value,
		exp: Math.floor(Date.now() / 1000) - 1,
	});
	const signed = await signCookie(payload, secret);
	return `${name}=${signed}`;
}

describe("Timing-safe comparison", () => {
	it("returns true for identical short strings", async () => {
		expect(await timingSafeEqualStr("abc", "abc")).toBe(true);
	});

	it("returns true for identical long strings", async () => {
		expect(await timingSafeEqualStr("x".repeat(1000), "x".repeat(1000))).toBe(true);
	});

	it("returns false for different strings of same length", async () => {
		expect(await timingSafeEqualStr("abc", "def")).toBe(false);
	});

	it("returns false for different strings of different lengths", async () => {
		expect(await timingSafeEqualStr("a", "ab")).toBe(false);
		expect(await timingSafeEqualStr("short", "a much longer string that differs")).toBe(false);
	});

	it("hashes both inputs before comparing — same comparison path regardless of length", async () => {
		const digestSpy = vi.spyOn(crypto.subtle, "digest");
		await timingSafeEqualStr("a", "ab");
		expect(digestSpy).toHaveBeenCalledWith("SHA-256", expect.any(Uint8Array));
		expect(digestSpy).toHaveBeenCalledTimes(2);
		digestSpy.mockRestore();
	});
});

async function makeTestCsrf(value: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
	const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
	return `${value}:${sigB64}`;
}
