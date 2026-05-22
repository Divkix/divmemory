#!/usr/bin/env node

/**
 * SessionStart hook — reads Droid session JSON from stdin, determines project ID,
 * GETs /context from Worker, writes markdown context block to stdout.
 * Always exits 0 (non-blocking).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const DEFAULT_WORKER_URL = "https://divmemory.divkix.workers.dev";

/**
 * Get the project ID from a directory.
 * Tries `git remote get-url origin` first, falls back to a hashed absolute-path slug.
 * Normalizes .git suffix, trailing slashes, lowercases, SSH git@, and protocols.
 * Shared logic with session-end.mjs for consistency.
 */
export async function getProjectId(cwd) {
	const projectCwd = cwd || process.cwd();
	try {
		const result = await new Promise((resolve, reject) => {
			const child = spawn("git", ["-C", projectCwd, "remote", "get-url", "origin"], {
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

		// Normalize: strip .git suffix and trailing slashes
		let normalized = result.replace(/\.git$/, "").replace(/\/+$/, "");

		// Lowercase the string
		normalized = normalized.toLowerCase();

		// Strip protocol (https://, ssh://, etc.)
		normalized = normalized.replace(/^[a-z]+:\/\//, "");

		// Convert SSH "git@host:path" to "host/path"
		if (normalized.startsWith("git@")) {
			normalized = normalized.replace(/^git@/, "").replace(":", "/");
		}

		return normalized;
	} catch {
		const absolute = resolve(projectCwd);
		const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
		return `local-${hash}-${basename(absolute)}`;
	}
}

function getWorkerUrl() {
	return process.env.DIVMEMORY_WORKER_URL || DEFAULT_WORKER_URL;
}

function getApiKey() {
	return process.env.DIVMEMORY_API_KEY;
}

function writeFallback(stdout) {
	stdout("\n");
}

function getDivmemoryHome() {
	return process.env.DIVMEMORY_HOME || join(homedir(), ".divmemory");
}

function cachePathForProject(projectId) {
	return join(getDivmemoryHome(), "cache", `${encodeURIComponent(projectId)}.txt`);
}

function readCachedContext(projectId) {
	const path = cachePathForProject(projectId);
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

function writeCachedContext(projectId, text) {
	if (!text?.trim()) return;
	const path = cachePathForProject(projectId);
	mkdirSync(join(getDivmemoryHome(), "cache"), { recursive: true, mode: 0o700 });
	writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
}

/**
 * Main entry point for the SessionStart hook.
 * Reads stdin JSON, determines project, GETs /context, writes to stdout.
 * Always returns exitCode 0 (non-blocking).
 */
export async function processSessionStart(stdinData, deps = {}) {
	const stderr = deps.stderr || ((s) => process.stderr.write(`${s}\n`));
	const stdout = deps.stdout || ((s) => process.stdout.write(s));
	const fetch_ = deps.fetch || ((...args) => fetch(...args));

	const WORKER_URL = getWorkerUrl();
	const API_KEY = getApiKey();

	if (!stdinData?.trim()) {
		stderr("[divmemory] No stdin data received.");
		writeFallback(stdout);
		return { exitCode: 0 };
	}

	let payload;
	try {
		payload = JSON.parse(stdinData);
	} catch (err) {
		stderr(`[divmemory] Malformed JSON in stdin: ${err.message}`);
		writeFallback(stdout);
		return { exitCode: 0 };
	}

	const { cwd, hook_event_name } = payload;

	if (hook_event_name && hook_event_name !== "SessionStart") {
		stderr(
			`[divmemory] Warning: expected hook_event_name=SessionStart, got ${hook_event_name}. Exiting.`,
		);
		writeFallback(stdout);
		return { exitCode: 0 };
	}

	const projectId = await getProjectId(cwd || process.cwd());
	const cached = readCachedContext(projectId);

	if (!API_KEY) {
		stderr("[divmemory] DIVMEMORY_API_KEY not set. No context injected.");
		if (cached.trim()) stdout(`${cached.trimEnd()}\n`);
		else writeFallback(stdout);
		return { exitCode: 0 };
	}

	// Droid currently injects only one SessionStart hook output; keep this hook fast when
	// cache exists so memory context is not displaced by other startup hooks.
	if (cached.trim()) {
		stdout(`${cached.trimEnd()}\n`);
		return { exitCode: 0 };
	}

	const maxChars = 12000;
	const encoded = encodeURIComponent(projectId);
	const url = `${WORKER_URL}/context?project=${encoded}&max_chars=${maxChars}`;

	try {
		const res = await fetch_(url, {
			headers: {
				Authorization: `Bearer ${API_KEY}`,
			},
		});

		if (!res.ok) {
			const text = await res.text();
			stderr(`[divmemory] Worker returned ${res.status}: ${text}`);
			writeFallback(stdout);
			return { exitCode: 0 };
		}

		const text = await res.text();
		if (!text?.trim()) {
			stderr("[divmemory] Empty context received.");
			if (cached.trim()) stdout(`${cached.trimEnd()}\n`);
			else writeFallback(stdout);
			return { exitCode: 0 };
		}

		if (text.trim()) {
			stdout(`${text.trimEnd()}\n`);
			writeCachedContext(projectId, text);
		} else if (cached.trim()) {
			stdout(`${cached.trimEnd()}\n`);
		} else {
			writeFallback(stdout);
		}
	} catch (err) {
		stderr(`[divmemory] Network error fetching context: ${err.message}`);
		if (cached.trim()) stdout(`${cached.trimEnd()}\n`);
		else writeFallback(stdout);
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

	await processSessionStart(stdinData);
	process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
