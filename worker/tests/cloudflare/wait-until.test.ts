import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("ctx.waitUntil lifecycle (Workers runtime)", () => {
	const origFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [{ message: { content: JSON.stringify({ facts: [] }) } }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
	});

	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	it("returns before background ingest completes, then persists session via waitUntil", async () => {
		const ctx = createExecutionContext();
		const body = {
			session_id: "sess-cf-wait",
			project_id: "proj/cf-wait",
			conversation: "User: hello\n\nAssistant: world",
		};

		const res = await exports.default.fetch(
			new Request("http://localhost/ingest", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.DIVMEMORY_API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			}),
			env,
			ctx,
		);

		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; facts_written: number };
		expect(json.ok).toBe(true);
		expect(json.facts_written).toBe(0);

		await waitOnExecutionContext(ctx);

		const session = await env.DB.prepare(
			"SELECT id, raw_text, consolidated FROM sessions WHERE id = ?",
		)
			.bind(body.session_id)
			.first<{ id: string; raw_text: string; consolidated: number }>();
		expect(session?.id).toBe(body.session_id);
		expect(session?.raw_text).toBe(body.conversation);
		expect(session?.consolidated).toBe(0);
	});

	it("returns HTTP 200 before a rejecting waitUntil task is settled", async () => {
		const ctx = createExecutionContext();
		const res = await exports.default.fetch(new Request("http://localhost/health"), env, ctx);
		expect(res.status).toBe(200);
		ctx.waitUntil(Promise.reject(new Error("background failure")).catch(() => undefined));
		await waitOnExecutionContext(ctx);
	});
});
