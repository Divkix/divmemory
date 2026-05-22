import type { MessageBatch } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { bearerAuth, hybridAuth } from "./auth";
import { createLoginRoute } from "./login";
import type { QueueMessage } from "./queue/ingest-consumer";
import { processIngestQueue } from "./queue/ingest-consumer";
import * as consolidate from "./routes/consolidate";
import { createContextRoute } from "./routes/context";
import * as ingest from "./routes/ingest";
import { createMemoriesRoute } from "./routes/memories";
import { createStatusRoute } from "./routes/status";
import { createWebUiRoute } from "./routes/webui";

/* ────────── Wire auto-consolidation trigger ────────── */
ingest.setConsolidationTrigger(
	(projectId: string, db: Parameters<typeof consolidate.runConsolidation>[1], c: unknown) => {
		const env =
			typeof c === "object" &&
			c !== null &&
			"env" in c &&
			typeof (c as Record<string, unknown>).env === "object" &&
			(c as Record<string, unknown>).env !== null
				? ((c as Record<string, unknown>).env as Record<string, string>)
				: {};
		return consolidate.runConsolidation(projectId, db, {
			FIREWORKS_API_KEY: env.FIREWORKS_API_KEY ?? "",
			FIREWORKS_MODEL: env.FIREWORKS_MODEL ?? "",
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
	const rawBody = c.req.raw.body;
	const contentLengthHeader = c.req.header("Content-Length");
	const hasBody =
		rawBody !== undefined
			? rawBody !== null
			: c.req.header("Transfer-Encoding") !== undefined ||
				(contentLengthHeader !== undefined && Number(contentLengthHeader || "0") > 0);
	if (!hasBody) {
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
app.use("/status", bearerAuth("divmemory_session"));
app.use("/memories/*", hybridAuth("divmemory_session"));
app.use("/memories", hybridAuth("divmemory_session"));

// Web UI routes: cookie only
/* ────────── Health check (unprotected) ────────── */
app.get("/health", (c) => c.json({ ok: true }));

/* ────────── Login (unprotected) ────────── */
createLoginRoute(app, "divmemory_session");

/* ────────── Web UI routes ────────── */
createWebUiRoute(app);

function narrowEnv(c: unknown): Record<string, string> {
	if (
		typeof c === "object" &&
		c !== null &&
		"env" in c &&
		typeof (c as Record<string, unknown>).env === "object" &&
		(c as Record<string, unknown>).env !== null
	) {
		return (c as Record<string, unknown>).env as Record<string, string>;
	}
	return {};
}

/* ────────── Ingest route ────────── */
ingest.createIngestRoute(app, undefined, {
	getEnv: (c) => {
		const env = narrowEnv(c);
		return {
			FIREWORKS_API_KEY: env.FIREWORKS_API_KEY,
			FIREWORKS_MODEL: env.FIREWORKS_MODEL,
		};
	},
});

/* ────────── Context route ────────── */
createContextRoute(app);

/* ────────── Consolidation route ────────── */
consolidate.createConsolidateRoute(app, undefined, {
	getEnv: (c) => {
		const env = narrowEnv(c);
		return {
			FIREWORKS_API_KEY: env.FIREWORKS_API_KEY,
			FIREWORKS_MODEL: env.FIREWORKS_MODEL,
		};
	},
});

/* ────────── Memory CRUD routes ────────── */
createMemoriesRoute(app);

/* ────────── Status route ────────── */
createStatusRoute(app);

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
	queue: async (
		batch: MessageBatch<QueueMessage>,
		env: { DB: D1Database; FIREWORKS_API_KEY?: string; FIREWORKS_MODEL?: string },
		ctx: Pick<ExecutionContext, "waitUntil">,
	): Promise<void> => {
		await processIngestQueue(batch, env, ctx);
	},
};
