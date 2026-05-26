import type { D1Database, ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DbLike } from "../lib/db";
import {
	extractFacts,
	processExtractionAfter,
	triggerConsolidation,
	unconsolidatedCount,
} from "../routes/ingest";
import { sessions } from "../schema";

export interface QueueMessage {
	sessionId: string;
	projectId: string;
}

export async function processIngestQueue(
	batch: MessageBatch<QueueMessage>,
	env: {
		DB: D1Database | DbLike;
		FIREWORKS_API_KEY?: string;
		FIREWORKS_MODEL?: string;
	},
	_ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
	// Guard against empty batch
	if (!batch.messages || batch.messages.length === 0) {
		return;
	}

	if (!env.DB) {
		throw new Error("D1 Database binding 'DB' is missing in environment");
	}
	const dbCtx = "select" in env.DB ? env.DB : drizzle(env.DB as D1Database);

	const fwKey = env.FIREWORKS_API_KEY ?? "";
	const fwModel = env.FIREWORKS_MODEL || undefined; // extractFacts has default model if undefined

	for (const msg of batch.messages) {
		const { sessionId } = msg.body;

		// Fetch session raw text and metadata from DB
		const sessionRow = await dbCtx.select().from(sessions).where(eq(sessions.id, sessionId)).get();

		if (!sessionRow) {
			console.warn(
				`[Queue Consumer] Session ${sessionId} not found in database. Acknowledging message.`,
			);
			continue;
		}

		// Perform Fireworks fact extraction
		const now = new Date().toISOString();
		try {
			const result = await extractFacts(sessionRow.rawText || "", fwKey, fwModel);

			// Check for transient errors first: e.g. status code 429, timeout, or abort
			if (result.error) {
				const isTransient =
					result.error.includes("429") ||
					result.error.toLowerCase().includes("timeout") ||
					result.error.toLowerCase().includes("abort") ||
					result.error.toLowerCase().includes("too many requests") ||
					result.error.toLowerCase().includes("rate limit");

				if (isTransient) {
					// Throw the error to allow CF Queues retry mechanism to kick in
					throw new Error(`Transient extraction failure: HTTP ${result.error}`);
				}
			}

			// Process facts and update database
			await processExtractionAfter(
				dbCtx,
				{
					session_id: sessionId,
					project_id: sessionRow.projectId,
					source: sessionRow.source || "droid",
					conversation: sessionRow.rawText || "",
				},
				result,
				now,
			);

			// Trigger auto-consolidation if unconsolidated count >= 5
			const unconsol = await unconsolidatedCount(sessionRow.projectId, dbCtx);
			if (unconsol >= 5) {
				// Compatibility: Pass `{ env }` as context because the trigger only accesses `.env`
				const promise = triggerConsolidation(sessionRow.projectId, dbCtx, { env });
				if (promise instanceof Promise) {
					if (_ctx?.waitUntil) {
						_ctx.waitUntil(promise);
					} else {
						await promise;
					}
				}
			}
		} catch (error) {
			// Check if this error is transient, if so, rethrow it
			const errorMsg = error instanceof Error ? error.message : String(error);
			const isTransient =
				errorMsg.includes("429") ||
				errorMsg.toLowerCase().includes("timeout") ||
				errorMsg.toLowerCase().includes("abort") ||
				errorMsg.toLowerCase().includes("too many requests") ||
				errorMsg.toLowerCase().includes("rate limit") ||
				errorMsg.toLowerCase().includes("transient");

			if (isTransient) {
				throw error;
			}

			// For permanent errors (like parsing garbage), record the failure in DB and do not throw (acknowledging msg)
			await dbCtx
				.update(sessions)
				.set({ consolidated: -1, extractionError: errorMsg })
				.where(eq(sessions.id, sessionId));
		}
	}
}
