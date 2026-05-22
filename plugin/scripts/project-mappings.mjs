import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function divmemoryHome(home) {
	return home ?? process.env.DIVMEMORY_HOME ?? join(homedir(), ".divmemory");
}

export function mappingsPath(home) {
	return join(divmemoryHome(home), "project_mappings.json");
}

export function lookupProjectMapping(absolutePath, options = {}) {
	try {
		const raw = readFileSync(mappingsPath(options.home), "utf-8");
		const mappings = JSON.parse(raw);
		if (typeof mappings !== "object" || mappings === null || Array.isArray(mappings)) {
			return null;
		}
		const mapped = mappings[absolutePath];
		return typeof mapped === "string" ? mapped : null;
	} catch {
		return null;
	}
}

export function normalizeGitRemote(url) {
	let normalized = url.replace(/\.git$/, "").replace(/\/+$/, "");
	normalized = normalized.toLowerCase();
	normalized = normalized.replace(/^[a-z]+:\/\//, "");
	if (normalized.startsWith("git@")) {
		normalized = normalized.replace(/^git@/, "").replace(":", "/");
	}
	return normalized;
}

export function localProjectId(absolutePath) {
	const hash = createHash("sha256").update(absolutePath).digest("hex").slice(0, 12);
	return `local-${hash}-${basename(absolutePath)}`;
}

/**
 * Resolve project ID: git remote origin → central path mapping → local hash fallback.
 */
export async function resolveProjectId(cwd, options = {}) {
	const absolutePath = resolve(cwd || process.cwd());
	try {
		const result = await new Promise((resolvePromise, reject) => {
			const child = spawn("git", ["-C", absolutePath, "remote", "get-url", "origin"], {
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
				if (code === 0) resolvePromise(stdout.trim());
				else reject(new Error(stderr || `git exited ${code}`));
			});
		});
		return normalizeGitRemote(result);
	} catch {
		return lookupProjectMapping(absolutePath, options) ?? localProjectId(absolutePath);
	}
}

/** Alias for hook exports and tests. */
export const getProjectId = resolveProjectId;

/** Serializes mapping writes within this process (session-end concurrency). */
const writeChains = new Map();

function writeChainFor(home) {
	const key = divmemoryHome(home);
	let chain = writeChains.get(key);
	if (!chain) {
		chain = Promise.resolve();
		writeChains.set(key, chain);
	}
	return chain;
}

async function writeProjectMappingUnlocked(absolutePath, projectId, options = {}) {
	const path = mappingsPath(options.home);
	let mappings = {};
	try {
		const raw = await readFile(path, "utf-8");
		mappings = JSON.parse(raw);
		if (typeof mappings !== "object" || mappings === null || Array.isArray(mappings)) {
			mappings = {};
		}
	} catch {
		mappings = {};
	}

	mappings[absolutePath] = projectId;

	const tmpPath = `${path}.${randomUUID()}.tmp`;
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(tmpPath, `${JSON.stringify(mappings, null, 2)}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
	await rename(tmpPath, path);
}

/**
 * Persist absolute path → canonical project id when git remote was resolved.
 * Skips local-* fallbacks. Writes atomically via temp file + rename.
 */
export async function writeProjectMapping(absolutePath, projectId, options = {}) {
	if (projectId.startsWith("local-")) return;

	const prior = writeChainFor(options.home);
	const work = prior.then(() => writeProjectMappingUnlocked(absolutePath, projectId, options));
	writeChains.set(
		divmemoryHome(options.home),
		work.catch(() => {}),
	);
	await work;
}
