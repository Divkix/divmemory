import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { bearerAuth, cookieAuth, hybridAuth } from "./auth";
import { csrfValidate } from "./csrf";
import { createLoginRoute } from "./login";
import * as consolidate from "./routes/consolidate";
import { createContextRoute } from "./routes/context";
import * as ingest from "./routes/ingest";

/* ────────── Wire auto-consolidation trigger ────────── */
ingest.setConsolidationTrigger(
	(projectId: string, db: Parameters<typeof consolidate.runConsolidation>[1], c: unknown) => {
		void consolidate.runConsolidation(projectId, db, {
			FIREWORKS_API_KEY: (c as { env: Record<string, string> }).env.FIREWORKS_API_KEY ?? "",
			FIREWORKS_MODEL: (c as { env: Record<string, string> }).env.FIREWORKS_MODEL ?? "",
		});
	},
);

const app = new Hono();

/* ────────── Global security middleware ────────── */

app.use("*", async (c, next) => {
	const contentLength = Number(c.req.header("Content-Length") || "0");
	if (contentLength > 10 * 1024 * 1024) {
		return c.json({ error: "Payload Too Large" }, 413);
	}
	return next();
});

app.use("*", async (c, next) => {
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

/* ────────── Auth middleware per route ────────── */

// API routes: Bearer only
app.use("/ingest", bearerAuth("divmemory_session"));
app.use("/context", bearerAuth("divmemory_session"));
app.use("/consolidate", bearerAuth("divmemory_session"));
app.use("/memories/*", hybridAuth("divmemory_session"));
app.use("/memories", hybridAuth("divmemory_session"));

// Web UI routes: cookie only
/* ────────── Health check (unprotected) ────────── */
app.get("/health", (c) => c.json({ ok: true }));

/* ────────── Login (unprotected) ────────── */
createLoginRoute(app, "divmemory_session");

/* ────────── Ingest route ────────── */
ingest.createIngestRoute(app, undefined, {
	getEnv: (c) => ({
		FIREWORKS_API_KEY: (c.env as Record<string, string>).FIREWORKS_API_KEY,
		FIREWORKS_MODEL: (c.env as Record<string, string>).FIREWORKS_MODEL,
	}),
});

/* ────────── Context route ────────── */
createContextRoute(app);

/* ────────── Consolidation route ────────── */
consolidate.createConsolidateRoute(app, undefined, {
	getEnv: (c) => ({
		FIREWORKS_API_KEY: (c.env as Record<string, string>).FIREWORKS_API_KEY,
		FIREWORKS_MODEL: (c.env as Record<string, string>).FIREWORKS_MODEL,
	}),
});

/* ────────── Stub protected routes — implemented by other features ────────── */
app.get("/memories", (c) => c.json({ memories: [] }));
app.patch("/memories/:id", csrfValidate("csrf_token"), (c) => c.json({ ok: true }));
app.delete("/memories/:id", csrfValidate("csrf_token"), (c) => c.json({ ok: true }));

/* ────────── Web UI index (cookie-protected) ────────── */
app.get("/", cookieAuth("divmemory_session"), (c) => c.text("divmemory web ui"));

/* ────────── Cron handler ────────── */
async function scheduled(
	_event: ScheduledEvent,
	env: { DB: D1Database; FIREWORKS_API_KEY?: string; FIREWORKS_MODEL?: string },
	_ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
	const db = drizzle(env.DB);
	await consolidate.runCronConsolidation(db, {
		FIREWORKS_API_KEY: env.FIREWORKS_API_KEY ?? "",
		FIREWORKS_MODEL: env.FIREWORKS_MODEL ?? "",
	});
}

export default {
	fetch: app.fetch,
	scheduled,
};
