import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const DEFAULT_WORKER_URL = "https://divmemory.divkix.workers.dev";

/**
 * Get the project ID from a directory.
 * Tries `git remote get-url origin` first, falls back to basename(cwd).
 * Normalizes .git suffix, trailing slashes, and lowercases the URL.
 */
export async function getProjectId(cwd) {
	try {
		const result = await new Promise((resolve, reject) => {
			const child = spawn("git", ["-C", cwd, "remote", "get-url", "origin"], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => {
				stdout += d;
			});
			child.stderr.on("data", (d) => {
				stderr += d;
			});
			child.on("error", (err) => reject(err));
			child.on("close", (code) => {
				if (code === 0) resolve(stdout.trim());
				else reject(new Error(stderr || `git exited ${code}`));
			});
		});

		// Normalize: strip .git suffix, trailing slashes, and lowercase
		let normalized = result
			.replace(/\.git$/, "")
			.replace(/\/+$/, "")
			.toLowerCase();

		// Convert SSH "git@host:path" to "host/path"
		if (normalized.startsWith("git@")) {
			normalized = normalized.replace(/^git@/, "").replace(":", "/");
		}

		// Strip protocol (https://, ssh://, etc.)
		normalized = normalized.replace(/^[a-z]+:\/\//, "");

		return normalized;
	} catch {
		return basename(cwd || process.cwd());
	}
}

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

		if (msg.type === "system-reminder" || msg.type === "system-notification") continue;
		if (msg.type === "thinking") continue;
		if (msg.type === "tool_use") continue;
		if (msg.type === "tool_result") continue;

		const role = msg.role || msg.type;
		if (role !== "user" && role !== "assistant") continue;

		let text = "";
		if (typeof msg.content === "string") {
			text = msg.content;
		} else if (Array.isArray(msg.content)) {
			text = msg.content
				.filter((c) => c?.type === "text")
				.map((c) => c.text || "")
				.join("\n");
		}

		if (!text.trim()) continue;

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

/**
 * Determine project_name from project_id.
 * If project_id is a path-like string, uses basename; otherwise returns project_id.
 */
function getProjectName(projectId) {
	// If it contains a slash, extract the last segment
	const lastSlash = projectId.lastIndexOf("/");
	if (lastSlash >= 0) return projectId.slice(lastSlash + 1);
	return projectId;
}

/**
 * Main entry point for the SessionEnd hook.
 * Reads stdin JSON, parses transcript, determines project, POSTs to /ingest.
 * Always exits 0 (non-blocking).
 */
export async function processSessionEnd(stdinData, deps = {}) {
	const stderr = deps.stderr || ((s) => process.stderr.write(`${s}\n`));
	const _stdout = deps.stdout || ((s) => process.stdout.write(s));
	const fetch_ = deps.fetch || ((...args) => fetch(...args));

	const WORKER_URL = process.env.DIVMEMORY_WORKER_URL || DEFAULT_WORKER_URL;
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

	const body = {
		session_id,
		project_id: projectId,
		project_name: getProjectName(projectId),
		source: "droid",
		conversation,
		metadata: {},
	};

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 30000);

		const res = await fetch_(`${WORKER_URL}/ingest`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!res.ok) {
			const text = await res.text();
			stderr(`[divmemory] Worker returned ${res.status}: ${text}`);
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
