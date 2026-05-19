#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_WORKER_URL = "https://divmemory.divkix.workers.dev";
const DEFAULT_LIMIT = 50;
const RATE_LIMIT_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;

export const HELP_TEXT = `Usage: npx divmemory-bootstrap [options]

Options:
  --dir <path>      Directory to scan for JSONL files (default: ~/.factory/sessions/)
  --limit <n>       Max sessions to process (default: 50)
  --dry-run         Print what would be sent without making network requests
  --api-key <key>   API key (overrides DIVMEMORY_API_KEY env var)
  --worker <url>    Worker base URL (overrides DIVMEMORY_WORKER_URL env var)
  --help            Show this help message
`;

export type CliOptions = {
	help?: boolean;
	dir?: string;
	limit?: number;
	dryRun?: boolean;
	apiKey?: string;
	worker?: string;
};

export function parseFlags(args: string[]): CliOptions {
	const result: CliOptions = {};
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === "--help") {
			result.help = true;
		} else if (arg === "--dir") {
			if (i + 1 >= args.length) throw new Error("Missing value for --dir");
			result.dir = args[++i];
		} else if (arg === "--limit") {
			if (i + 1 >= args.length) throw new Error("Missing value for --limit");
			const val = Number.parseInt(args[++i], 10);
			if (Number.isNaN(val) || val < 0) throw new Error(`Invalid limit value: ${args[i]}`);
			result.limit = val;
		} else if (arg === "--dry-run") {
			result.dryRun = true;
		} else if (arg === "--api-key") {
			if (i + 1 >= args.length) throw new Error("Missing value for --api-key");
			result.apiKey = args[++i];
		} else if (arg === "--worker") {
			if (i + 1 >= args.length) throw new Error("Missing value for --worker");
			result.worker = args[++i];
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown flag: ${arg}`);
		} else {
			throw new Error(`Unexpected argument: ${arg}`);
		}
		i++;
	}
	return result;
}

export function expandTilde(input: string): string {
	if (input.startsWith("~/")) {
		return join(homedir(), input.slice(2));
	}
	if (input === "~") {
		return homedir();
	}
	return resolve(input);
}

export type SessionFile = {
	filePath: string;
	mtime: number;
	projectDir: string;
};

export async function findSessionFiles(dir: string, limit = DEFAULT_LIMIT): Promise<SessionFile[]> {
	const resolved = expandTilde(dir);
	let stats: Stats;
	try {
		stats = statSync(resolved);
	} catch (_err) {
		throw new Error(`Directory not found: ${resolved}`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`Not a directory: ${resolved}`);
	}

	const files: SessionFile[] = [];
	function scan(currentDir: string) {
		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isDirectory()) {
				scan(fullPath);
			} else if (entry.isSymbolicLink()) {
				const s = statSync(fullPath);
				if (s.isDirectory()) {
					scan(fullPath);
				}
			} else if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.startsWith(".")) {
				const s = statSync(fullPath);
				// Determine project directory:
				// Under ~/.factory/sessions/ the first subdir is the encoded project path.
				// If the file is directly in the scanned dir (no parent subdir), use the scanned dir.
				let projectDir = dirname(fullPath);
				const relative = fullPath.slice(resolved.length).replace(/^\//, "");
				if (relative.includes("/")) {
					const topDir = relative.split("/")[0];
					projectDir = decodeProjectDir(topDir) || projectDir;
				}
				files.push({ filePath: fullPath, mtime: s.mtimeMs, projectDir });
			}
		}
	}
	scan(resolved);

	// Sort by mtime descending, tie-break by filepath ascending for determinism
	files.sort((a, b) => {
		if (b.mtime !== a.mtime) return b.mtime - a.mtime;
		return a.filePath.localeCompare(b.filePath);
	});

	return files.slice(0, limit);
}

export function decodeProjectDir(encoded: string): string | null {
	// The encoded format replaces / with - (e.g. /Users/div/projects/my-app -> -Users-div-projects-my-app)
	if (!encoded.startsWith("-")) return null;
	const rest = encoded.slice(1);
	const dashCount = (rest.match(/-/g) || []).length;

	// Ambiguity: dashes could be original directory names or encoded slashes.
	// Try all combinations of treating each dash as either "/" or "-".
	// Start with the assumption that ALL dashes were originally slashes (most common case for paths),
	// then progressively try fewer replacements from the right, checking which decoded path exists.
	for (let k = dashCount; k >= 0; k--) {
		const dashPositions: number[] = [];
		for (let i = 0; i < rest.length; i++) {
			if (rest[i] === "-") dashPositions.push(i);
		}
		const chars = rest.split("");
		for (let i = 0; i < k; i++) {
			chars[dashPositions[i]] = "/";
		}
		const attempt = `/${chars.join("")}`;
		try {
			if (statSync(attempt).isDirectory()) return attempt;
		} catch {
			// ignore
		}
	}

	// If no decoded path exists on disk, return the fully-decoded path anyway
	// (the caller will fall back to basename if git remote doesn't work).
	return `/${rest.replace(/-/g, "/")}`;
}

export function extractConversation(jsonlContent: string): string {
	const lines = jsonlContent.trim().split("\n");
	const turns: string[] = [];
	let currentRole: "user" | "assistant" | null = null;
	let currentText = "";

	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;

		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		const type = msg.type as string | undefined;
		if (type === "system-reminder" || type === "system-notification") continue;
		if (type === "thinking") continue;
		if (type === "tool_use") continue;
		if (type === "tool_result") continue;

		const role = (msg.role as string | undefined) || type;
		if (role !== "user" && role !== "assistant") continue;

		let text = "";
		if (typeof msg.content === "string") {
			text = msg.content;
		} else if (Array.isArray(msg.content)) {
			text = (msg.content as Array<{ type?: string; text?: string }>)
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
			currentRole = role as "user" | "assistant";
			currentText = text;
		}
	}

	if (currentRole) {
		const prefix = currentRole === "user" ? "User" : "Assistant";
		turns.push(`${prefix}: ${currentText.trim()}`);
	}

	return turns.join("\n\n");
}

export async function getProjectId(cwd: string): Promise<string> {
	try {
		const result = await new Promise<string>((resolve, reject) => {
			const child = spawn("git", ["-C", cwd, "remote", "get-url", "origin"], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d: string) => {
				stdout += d;
			});
			child.stderr.on("data", (d: string) => {
				stderr += d;
			});
			child.on("error", (err) => reject(err));
			child.on("close", (code) => {
				if (code === 0) resolve(stdout.trim());
				else reject(new Error(stderr || `git exited ${code}`));
			});
		});

		let normalized = result
			.replace(/\.git$/, "")
			.replace(/\/+$/, "")
			.toLowerCase();
		if (normalized.startsWith("git@")) {
			normalized = normalized.replace(/^git@/, "").replace(":", "/");
		}
		normalized = normalized.replace(/^[a-z]+:\/\//, "");
		return normalized;
	} catch {
		return basename(cwd || process.cwd());
	}
}

export function getProjectName(projectId: string): string {
	const lastSlash = projectId.lastIndexOf("/");
	if (lastSlash >= 0) return projectId.slice(lastSlash + 1);
	return projectId;
}

export function getSessionIdFromFilename(filename: string): string {
	return basename(filename, ".jsonl");
}

export function resolveApiKey(flagValue?: string): string {
	const key = flagValue ?? process.env.DIVMEMORY_API_KEY;
	if (!key || key.trim() === "") {
		throw new Error(
			"DIVMEMORY_API_KEY not set. Set it via --api-key flag or environment variable.",
		);
	}
	return key.trim();
}

export type IngestResult = {
	ok: boolean;
	facts_written?: number;
	error?: string;
};

export async function sendIngest(
	payload: {
		sessionId: string;
		projectId: string;
		projectName: string;
		conversation: string;
	},
	options: {
		workerUrl: string;
		apiKey: string;
		fetch?: (url: string, init: RequestInit) => Promise<Response>;
	},
): Promise<IngestResult> {
	const fetch_ = options.fetch || ((...args: Parameters<typeof fetch>) => fetch(...args));
	const base = options.workerUrl.replace(/\/$/, "");
	const url = `${base}/ingest`;

	const body = {
		session_id: payload.sessionId,
		project_id: payload.projectId,
		project_name: payload.projectName,
		source: "droid",
		conversation: payload.conversation,
		metadata: {},
	};

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const res = await fetch_(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${options.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!res.ok) {
			const text = await res.text();
			return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
		}

		const responseText = await res.text();
		if (!responseText?.trim()) {
			return { ok: false, error: "Empty response body from Worker" };
		}

		let responseBody: Record<string, unknown>;
		try {
			responseBody = JSON.parse(responseText) as Record<string, unknown>;
		} catch {
			return { ok: false, error: `Non-JSON response: ${responseText.slice(0, 200)}` };
		}

		return {
			ok: !!responseBody.ok,
			facts_written:
				typeof responseBody.facts_written === "number" ? responseBody.facts_written : 0,
		};
	} catch (err) {
		clearTimeout(timeoutId);
		return { ok: false, error: (err as Error).message };
	}
}

export type BatchResult = {
	exitCode: number;
	processed: number;
	successful: number;
	failed: number;
	totalFacts: number;
};

export async function runBatch(
	files: SessionFile[],
	options: {
		workerUrl: string;
		apiKey: string;
		dryRun: boolean;
		fetch?: (url: string, init: RequestInit) => Promise<Response>;
		stdout: (s: string) => void;
		stderr: (s: string) => void;
	},
): Promise<BatchResult> {
	let successful = 0;
	let failed = 0;
	let totalFacts = 0;
	let lastRequestTime = 0;

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		const index = i + 1;
		const filename = basename(file.filePath);
		const sessionId = getSessionIdFromFilename(filename);
		const mtimeDate = new Date(file.mtime).toISOString().slice(0, 10);

		// Derive project ID from the file's project directory
		let projectId: string;
		try {
			projectId = await getProjectId(file.projectDir);
		} catch {
			projectId = basename(file.projectDir);
		}
		const projectName = getProjectName(projectId);

		let conversation = "";
		try {
			const content = readFileSync(file.filePath, "utf-8");
			conversation = extractConversation(content);
		} catch (err) {
			options.stderr(
				`[${index}/${files.length}] ${projectName} ${mtimeDate} ✗ (Failed to read file: ${(err as Error).message})`,
			);
			failed++;
			continue;
		}

		if (options.dryRun) {
			options.stdout(
				`[${index}/${files.length}] ${projectName} ${mtimeDate} ○ (dry-run, ${conversation.length} chars)\n`,
			);
			successful++;
			continue;
		}

		// Rate limiting: enforce 1 req/sec
		if (index > 1) {
			const elapsed = Date.now() - lastRequestTime;
			if (elapsed < RATE_LIMIT_MS) {
				await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
			}
		}

		const result = await sendIngest(
			{ sessionId, projectId, projectName, conversation },
			{ workerUrl: options.workerUrl, apiKey: options.apiKey, fetch: options.fetch },
		);

		lastRequestTime = Date.now();

		if (result.ok) {
			const facts = result.facts_written ?? 0;
			options.stdout(
				`[${index}/${files.length}] ${projectName} ${mtimeDate} ✓ (${facts} facts extracted)\n`,
			);
			successful++;
			totalFacts += facts;
		} else {
			options.stdout(
				`[${index}/${files.length}] ${projectName} ${mtimeDate} ✗ (${result.error})\n`,
			);
			failed++;
		}
	}

	const processed = successful + failed;
	options.stdout(
		`Done. ${processed} sessions processed, ${successful} successful, ${failed} failed, ${totalFacts} total facts extracted.\n`,
	);

	let exitCode = 0;
	if (processed > 0 && successful === 0) exitCode = 1;
	return { exitCode, processed, successful, failed, totalFacts };
}

async function main() {
	const args = process.argv.slice(2);

	let flags: CliOptions;
	try {
		flags = parseFlags(args);
	} catch (err) {
		console.error((err as Error).message);
		console.error(HELP_TEXT);
		process.exit(1);
	}

	if (flags.help) {
		console.log(HELP_TEXT);
		process.exit(0);
	}

	const dir = flags.dir || "~/.factory/sessions/";
	const limit = flags.limit ?? DEFAULT_LIMIT;
	const dryRun = flags.dryRun ?? false;
	const workerUrl = flags.worker || process.env.DIVMEMORY_WORKER_URL || DEFAULT_WORKER_URL;

	let apiKey: string | undefined;
	try {
		apiKey = resolveApiKey(flags.apiKey);
	} catch (err) {
		if (!dryRun) {
			console.error((err as Error).message);
			process.exit(1);
		}
	}

	let files: SessionFile[];
	try {
		files = await findSessionFiles(dir, limit);
	} catch (err) {
		console.error((err as Error).message);
		process.exit(1);
	}

	if (files.length === 0) {
		console.log("No session files found.");
		process.exit(0);
	}

	// SIGINT handling: print partial summary on interrupt
	let interrupted = false;
	function onSigint() {
		interrupted = true;
	}
	process.on("SIGINT", onSigint);

	let successful = 0;
	let failed = 0;
	let totalFacts = 0;
	let lastRequestTime = 0;

	for (let i = 0; i < files.length; i++) {
		if (interrupted) {
			console.log("\nInterrupted.");
			break;
		}

		const file = files[i];
		const index = i + 1;
		const filename = basename(file.filePath);
		const sessionId = getSessionIdFromFilename(filename);
		const mtimeDate = new Date(file.mtime).toISOString().slice(0, 10);

		let projectId: string;
		try {
			projectId = await getProjectId(file.projectDir);
		} catch {
			projectId = basename(file.projectDir);
		}
		const projectName = getProjectName(projectId);

		let conversation = "";
		try {
			const content = readFileSync(file.filePath, "utf-8");
			conversation = extractConversation(content);
		} catch (err) {
			console.error(
				`[${index}/${files.length}] ${projectName} ${mtimeDate} ✗ (Failed to read file: ${(err as Error).message})`,
			);
			failed++;
			continue;
		}

		if (dryRun) {
			console.log(
				`[${index}/${files.length}] ${projectName} ${mtimeDate} ○ (dry-run, ${conversation.length} chars)`,
			);
			successful++;
			continue;
		}

		if (index > 1 && !interrupted) {
			const elapsed = Date.now() - lastRequestTime;
			if (elapsed < RATE_LIMIT_MS) {
				await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
			}
		}

		const result = await sendIngest(
			{ sessionId, projectId, projectName, conversation },
			{ workerUrl, apiKey: apiKey as string, fetch: undefined },
		);

		lastRequestTime = Date.now();

		if (result.ok) {
			const facts = result.facts_written ?? 0;
			console.log(
				`[${index}/${files.length}] ${projectName} ${mtimeDate} ✓ (${facts} facts extracted)`,
			);
			successful++;
			totalFacts += facts;
		} else {
			console.log(`[${index}/${files.length}] ${projectName} ${mtimeDate} ✗ (${result.error})`);
			failed++;
		}
	}

	process.off("SIGINT", onSigint);

	const processed = successful + failed;
	console.log(
		`Done. ${processed} sessions processed, ${successful} successful, ${failed} failed, ${totalFacts} total facts extracted.`,
	);

	let exitCode = 0;
	if (processed > 0 && successful === 0) exitCode = 1;
	process.exit(exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
