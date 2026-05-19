#!/usr/bin/env node

/**
 * SessionStart hook — reads Droid session JSON from stdin, determines project ID,
 * GETs /context from Worker, writes markdown context block to stdout.
 * Always exits 0 (non-blocking).
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";

const DEFAULT_WORKER_URL = "https://divmemory.divkix.workers.dev";
const WORKER_URL = process.env.DIVMEMORY_WORKER_URL || DEFAULT_WORKER_URL;
const API_KEY = process.env.DIVMEMORY_API_KEY;

async function getProjectId(cwd) {
	try {
		const result = await new Promise((resolve, reject) => {
			const child = spawn("git", ["-C", cwd, "remote", "get-url", "origin"], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			child.on("close", (code) => {
				if (code === 0) resolve(stdout.trim());
				else reject(new Error(stderr));
			});
		});
		const normalized = result
			.replace(/\.git$/, "")
			.replace(/\/+$/, "")
			.toLowerCase();
		return normalized;
	} catch {
		return basename(cwd || process.cwd());
	}
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

	if (!stdinData.trim()) {
		console.error("[divmemory] No stdin data received.");
		process.exit(0);
	}

	let payload;
	try {
		payload = JSON.parse(stdinData);
	} catch (err) {
		console.error("[divmemory] Malformed JSON in stdin:", err.message);
		process.exit(0);
	}

	const { cwd } = payload;
	const projectId = await getProjectId(cwd || process.cwd());

	if (!API_KEY) {
		console.error("[divmemory] DIVMEMORY_API_KEY not set. No context injected.");
		process.stdout.write("\n");
		process.exit(0);
	}

	const maxChars = 12000;
	const encoded = encodeURIComponent(projectId);
	const url = `${WORKER_URL}/context?project=${encoded}&max_chars=${maxChars}`;

	try {
		const res = await fetch(url, {
			headers: {
				Authorization: `Bearer ${API_KEY}`,
			},
		});

		if (!res.ok) {
			const text = await res.text();
			console.error(`[divmemory] Worker returned ${res.status}: ${text}`);
			process.stdout.write("\n");
			process.exit(0);
		}

		const text = await res.text();
		if (!text?.trim()) {
			console.error("[divmemory] Empty context received.");
			process.stdout.write("\n");
			process.exit(0);
		}

		process.stdout.write(`${text}\n`);
	} catch (err) {
		console.error("[divmemory] Network error fetching context:", err.message);
		process.stdout.write("\n");
	}

	process.exit(0);
}

main();
