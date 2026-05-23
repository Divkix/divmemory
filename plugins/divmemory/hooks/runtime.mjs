import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
	divmemoryHome,
	getProjectId,
	getProjectName,
	hasGitOrigin,
	writeProjectMapping,
} from "../../../plugin/scripts/project-mappings.mjs";

export { getProjectId };

const DEFAULT_WORKER_URL = "https://divmemory.divkix.workers.dev";

function workerUrl() {
	return process.env.DIVMEMORY_WORKER_URL || DEFAULT_WORKER_URL;
}

function apiKey() {
	return process.env.DIVMEMORY_API_KEY;
}

function cachePath(projectId) {
	return join(divmemoryHome(), "cache", `${encodeURIComponent(projectId)}.txt`);
}

function queuePath() {
	return join(divmemoryHome(), "queue.jsonl");
}

function readCache(projectId) {
	const path = cachePath(projectId);
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

function writeCache(projectId, text) {
	if (!text?.trim()) return;
	mkdirSync(join(divmemoryHome(), "cache"), { recursive: true, mode: 0o700 });
	writeFileSync(cachePath(projectId), text.endsWith("\n") ? text : `${text}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
}

async function postIngest(fetch_, url, key, body) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30000);
	try {
		return await fetch_(`${url}/ingest`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

async function appendQueue(entry) {
	const path = queuePath();
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", mode: 0o600 });
}

async function flushQueue(fetch_, url, key, stderr) {
	const path = queuePath();
	let content = "";
	try {
		content = await readFile(path, "utf-8");
	} catch {
		return;
	}
	const lines = content
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let failedAt = -1;
	for (let i = 0; i < lines.length; i++) {
		let entry;
		try {
			entry = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		try {
			const res = await postIngest(fetch_, url, key, entry.body);
			if (!res.ok) {
				failedAt = i;
				stderr(`[divmemory] Queued ingest still failing with ${res.status}: ${await res.text()}`);
				break;
			}
		} catch (err) {
			failedAt = i;
			stderr(`[divmemory] Queued ingest still offline: ${err.message}`);
			break;
		}
	}
	const remaining = failedAt === -1 ? [] : lines.slice(failedAt);
	const tmp = `${path}.tmp`;
	await writeFile(tmp, remaining.length > 0 ? `${remaining.join("\n")}\n` : "", {
		encoding: "utf-8",
		mode: 0o600,
	});
	await rename(tmp, path);
}

export function extractConversation(jsonlContent) {
	const turns = [];
	let currentRole = null;
	let currentText = "";

	for (const line of jsonlContent.trim().split("\n")) {
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
		if (
			type === "system-reminder" ||
			type === "system-notification" ||
			type === "thinking" ||
			type === "tool_use" ||
			type === "tool_result"
		) {
			continue;
		}
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
		if (text.length > 8000) {
			text = `${text.slice(0, 4000)}\n\n[... Truncated ${text.length - 8000} characters of verbose content ...]\n\n${text.slice(-4000)}`;
		}
		if (currentRole === role) {
			currentText += `\n${text}`;
		} else {
			if (currentRole) {
				turns.push(`${currentRole === "user" ? "User" : "Assistant"}: ${currentText.trim()}`);
			}
			currentRole = role;
			currentText = text;
		}
	}

	if (currentRole) {
		turns.push(`${currentRole === "user" ? "User" : "Assistant"}: ${currentText.trim()}`);
	}
	return turns.join("\n\n");
}

export async function processSessionStart(stdinData, deps = {}) {
	const stderr = deps.stderr || ((s) => process.stderr.write(`${s}\n`));
	const stdout = deps.stdout || ((s) => process.stdout.write(s));
	const fetch_ = deps.fetch || ((...args) => fetch(...args));

	if (!stdinData?.trim()) {
		stderr("[divmemory] No stdin data received.");
		stdout("\n");
		return { exitCode: 0 };
	}

	let payload;
	try {
		payload = JSON.parse(stdinData);
	} catch (err) {
		stderr(`[divmemory] Malformed JSON in stdin: ${err.message}`);
		stdout("\n");
		return { exitCode: 0 };
	}

	if (payload.hook_event_name && payload.hook_event_name !== "SessionStart") {
		stderr(
			`[divmemory] Warning: expected hook_event_name=SessionStart, got ${payload.hook_event_name}. Exiting.`,
		);
		stdout("\n");
		return { exitCode: 0 };
	}

	const projectId = await getProjectId(payload.cwd || process.cwd());
	const cached = readCache(projectId);
	const key = apiKey();
	if (!key) {
		stderr("[divmemory] DIVMEMORY_API_KEY not set. No context injected.");
		stdout(cached.trim() ? `${cached.trimEnd()}\n` : "\n");
		return { exitCode: 0 };
	}
	if (cached.trim()) {
		stdout(`${cached.trimEnd()}\n`);
		return { exitCode: 0 };
	}

	const url = `${workerUrl()}/context?project=${encodeURIComponent(projectId)}&max_chars=12000`;
	try {
		const res = await fetch_(url, { headers: { Authorization: `Bearer ${key}` } });
		if (!res.ok) {
			stderr(`[divmemory] Worker returned ${res.status}: ${await res.text()}`);
			stdout(cached.trim() ? `${cached.trimEnd()}\n` : "\n");
			return { exitCode: 0 };
		}
		const text = await res.text();
		if (!text?.trim()) {
			stderr("[divmemory] Empty context received.");
			stdout(cached.trim() ? `${cached.trimEnd()}\n` : "\n");
			return { exitCode: 0 };
		}
		if (text.trim()) {
			stdout(`${text.trimEnd()}\n`);
			writeCache(projectId, text);
		} else {
			stdout(cached.trim() ? `${cached.trimEnd()}\n` : "\n");
		}
	} catch (err) {
		stderr(`[divmemory] Network error fetching context: ${err.message}`);
		stdout(cached.trim() ? `${cached.trimEnd()}\n` : "\n");
	}
	return { exitCode: 0 };
}

export async function processSessionEnd(stdinData, deps = {}) {
	const stderr = deps.stderr || ((s) => process.stderr.write(`${s}\n`));
	const fetch_ = deps.fetch || ((...args) => fetch(...args));

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
	if (payload.hook_event_name && payload.hook_event_name !== "SessionEnd") {
		stderr(
			`[divmemory] Warning: expected hook_event_name=SessionEnd, got ${payload.hook_event_name}. Exiting.`,
		);
		return { exitCode: 0 };
	}
	if (!payload.session_id) {
		stderr("[divmemory] Missing session_id in hook payload.");
		return { exitCode: 0 };
	}
	if (!payload.transcript_path) {
		stderr("[divmemory] Missing transcript_path in hook payload.");
		return { exitCode: 0 };
	}

	const projectId = await getProjectId(payload.cwd || process.cwd());
	const resolvedCwd = resolve(payload.cwd || process.cwd());
	try {
		if (await hasGitOrigin(resolvedCwd)) {
			await writeProjectMapping(resolvedCwd, projectId);
		}
	} catch (err) {
		stderr(`[divmemory] Warning: Failed to persist project mapping: ${err.message}`);
	}

	const key = apiKey();
	if (!key) {
		stderr("[divmemory] DIVMEMORY_API_KEY not set. Skipping ingestion.");
		return { exitCode: 0 };
	}
	const url = workerUrl();
	await flushQueue(fetch_, url, key, stderr);
	let conversation = "";
	try {
		conversation = extractConversation(await readFile(payload.transcript_path, "utf-8"));
	} catch (err) {
		stderr(`[divmemory] Failed to read transcript: ${err.message}`);
	}

	const body = {
		session_id: payload.session_id,
		project_id: projectId,
		project_name: getProjectName(projectId),
		source: "droid",
		conversation,
		metadata: {},
	};

	try {
		const res = await postIngest(fetch_, url, key, body);
		if (!res.ok) {
			stderr(`[divmemory] Worker returned ${res.status}: ${await res.text()}`);
			await appendQueue({ body, created_at: new Date().toISOString() });
			stderr("[divmemory] Queued ingestion for retry.");
			return { exitCode: 0 };
		}
		const text = await res.text();
		if (!text?.trim()) {
			stderr("[divmemory] Empty response body from Worker.");
			return { exitCode: 0 };
		}
		let responseBody;
		try {
			responseBody = JSON.parse(text);
		} catch {
			stderr(`[divmemory] Worker returned non-JSON: ${text.slice(0, 200)}`);
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
