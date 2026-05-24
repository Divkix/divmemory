import {
	appendFile,
	mkdir,
	readFile,
	readFile as readFileAsync,
	rename,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
	divmemoryHome,
	getProjectId,
	getProjectName,
	hasGitOrigin,
	writeProjectMapping,
} from "./project-mappings.mjs";

export { getProjectId } from "./project-mappings.mjs";

const DEFAULT_WORKER_URL = "https://divmemory.divkix.workers.dev";

/**
 * Extract clean conversation text from a JSONL transcript string.
 * Keeps user and assistant text blocks; strips thinking, tool_use,
 * tool_result, system-reminder, and system-notification.
 */
export function extractConversation(jsonlContent) {
	const lines = jsonlContent.trim().split("\n");
	const turns = [];
	let currentRole = null;
	let currentText = "";

	for (const line of lines) {
		if (!line.trim()) continue;

		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}

		let targetMsg = msg;
		if (msg.type === "message" && msg.message && typeof msg.message === "object") {
			targetMsg = msg.message;
		}

		if (msg.visibility === "llm_only" || targetMsg.visibility === "llm_only") {
			continue;
		}

		const type = targetMsg.type;
		if (type === "system-reminder" || type === "system-notification") continue;
		if (type === "thinking") continue;
		if (type === "tool_use") continue;
		if (type === "tool_result") continue;

		const role = targetMsg.role || type;
		if (role !== "user" && role !== "assistant") continue;

		let text = "";
		if (typeof targetMsg.content === "string") {
			text = targetMsg.content;
		} else if (Array.isArray(targetMsg.content)) {
			text = targetMsg.content
				.filter((c) => c?.type === "text")
				.map((c) => c.text || "")
				.join("\n");
		}

		if (!text.trim()) continue;

		// Client-side content pruning: Truncate massive terminal output / diff dumps
		if (text.length > 8000) {
			text = `${text.slice(0, 4000)}\n\n[... Truncated ${text.length - 8000} characters of verbose content ...]\n\n${text.slice(-4000)}`;
		}

		if (currentRole === role) {
			currentText += `\n${text}`;
		} else {
			if (currentRole) {
				const prefix = currentRole === "user" ? "User" : "Assistant";
				turns.push(`${prefix}: ${currentText.trim()}`);
			}
			currentRole = role;
			currentText = text;
		}
	}

	if (currentRole) {
		const prefix = currentRole === "user" ? "User" : "Assistant";
		turns.push(`${prefix}: ${currentText.trim()}`);
	}

	return turns.join("\n\n");
}

function getQueuePath() {
	return join(divmemoryHome(), "queue.jsonl");
}

async function postIngest(fetch_, workerUrl, apiKey, body) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 30000);
	try {
		const res = await fetch_(`${workerUrl}/ingest`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		return res;
	} finally {
		clearTimeout(timeoutId);
	}
}

async function appendQueue(entry) {
	const queuePath = getQueuePath();
	await mkdir(dirname(queuePath), { recursive: true, mode: 0o700 });
	await appendFile(queuePath, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", mode: 0o600 });
}

async function flushQueue(fetch_, workerUrl, apiKey, stderr) {
	const queuePath = getQueuePath();
	let content = "";
	try {
		content = await readFileAsync(queuePath, "utf-8");
	} catch {
		return;
	}
	const lines = content
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return;

	let failedAt = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		try {
			const res = await postIngest(fetch_, workerUrl, apiKey, entry.body);
			if (!res.ok) {
				failedAt = i;
				const text = await res.text();
				stderr(`[divmemory] Queued ingest still failing with ${res.status}: ${text}`);
				break;
			}
		} catch (err) {
			failedAt = i;
			stderr(`[divmemory] Queued ingest still offline: ${err.message}`);
			break;
		}
	}

	const remaining = failedAt === -1 ? [] : lines.slice(failedAt);
	const tmpPath = `${queuePath}.tmp`;
	await writeFile(tmpPath, remaining.length > 0 ? `${remaining.join("\n")}\n` : "", {
		encoding: "utf-8",
		mode: 0o600,
	});
	await rename(tmpPath, queuePath);
}

/**
 * Main entry point for the SessionEnd hook.
 * Reads stdin JSON, parses transcript, determines project, POSTs to /ingest.
 * Always exits 0 (non-blocking).
 */
export async function processSessionEnd(stdinData, deps = {}) {
	const stderr = deps.stderr || ((s) => process.stderr.write(`${s}\n`));
	const fetch_ = deps.fetch || ((...args) => fetch(...args));

	const envWorkerUrl = process.env.DIVMEMORY_WORKER_URL;
	const WORKER_URL =
		envWorkerUrl && envWorkerUrl !== "undefined" && envWorkerUrl !== "null"
			? envWorkerUrl
			: DEFAULT_WORKER_URL;
	const API_KEY = process.env.DIVMEMORY_API_KEY;

	if (!stdinData?.trim()) {
		stderr("[divmemory] No stdin data received.");
		return { exitCode: 0 };
	}

	let payload;
	try {
		payload = JSON.parse(stdinData);
	} catch (err) {
		stderr(`[divmemory] Malformed JSON in stdin: ${err.message}`);
		return { exitCode: 0 };
	}

	const { session_id, cwd, transcript_path, hook_event_name } = payload;

	if (hook_event_name && hook_event_name !== "SessionEnd") {
		stderr(
			`[divmemory] Warning: expected hook_event_name=SessionEnd, got ${hook_event_name}. Exiting.`,
		);
		return { exitCode: 0 };
	}

	if (!session_id) {
		stderr("[divmemory] Missing session_id in hook payload.");
		return { exitCode: 0 };
	}

	if (!transcript_path) {
		stderr("[divmemory] Missing transcript_path in hook payload.");
		return { exitCode: 0 };
	}

	const projectId = await getProjectId(cwd || process.cwd());
	const resolvedCwd = resolve(cwd || process.cwd());
	try {
		if (await hasGitOrigin(resolvedCwd)) {
			await writeProjectMapping(resolvedCwd, projectId);
		}
	} catch (err) {
		stderr(`[divmemory] Warning: Failed to persist project mapping: ${err.message}`);
	}

	let conversation = "";
	try {
		const transcriptContent = await readFile(transcript_path, "utf-8");
		conversation = extractConversation(transcriptContent);
	} catch (err) {
		stderr(`[divmemory] Failed to read transcript: ${err.message}`);
		// Continue with empty conversation; still POST so session is recorded
	}

	if (!API_KEY) {
		stderr("[divmemory] DIVMEMORY_API_KEY not set. Skipping ingestion.");
		return { exitCode: 0 };
	}

	await flushQueue(fetch_, WORKER_URL, API_KEY, stderr);

	const body = {
		session_id,
		project_id: projectId,
		project_name: getProjectName(projectId),
		source: "droid",
		conversation,
		metadata: {},
	};

	try {
		const res = await postIngest(fetch_, WORKER_URL, API_KEY, body);

		if (!res.ok) {
			const text = await res.text();
			stderr(`[divmemory] Worker returned ${res.status}: ${text}`);
			await appendQueue({ body, created_at: new Date().toISOString() });
			stderr("[divmemory] Queued ingestion for retry.");
			return { exitCode: 0 };
		}

		const responseText = await res.text();
		if (!responseText?.trim()) {
			stderr("[divmemory] Empty response body from Worker.");
			return { exitCode: 0 };
		}

		let responseBody;
		try {
			responseBody = JSON.parse(responseText);
		} catch {
			stderr(`[divmemory] Worker returned non-JSON: ${responseText.slice(0, 200)}`);
			return { exitCode: 0 };
		}

		stderr(`[divmemory] Ingested. facts_written=${responseBody.facts_written ?? 0}`);
	} catch (err) {
		stderr(`[divmemory] Network error posting to Worker: ${err.message}`);
		await appendQueue({ body, created_at: new Date().toISOString() });
		stderr("[divmemory] Queued ingestion for retry.");
	}

	return { exitCode: 0 };
}

async function main() {
	let stdinData = "";
	try {
		for await (const chunk of process.stdin) {
			stdinData += chunk;
		}
	} catch (err) {
		console.error("[divmemory] Failed to read stdin:", err.message);
		process.exit(0);
	}

	await processSessionEnd(stdinData);
	process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
