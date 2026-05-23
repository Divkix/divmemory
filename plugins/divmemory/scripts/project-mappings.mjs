import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const LOCK_RETRIES = 20;
const LOCK_BASE_DELAY_MS = 25;
const LOCK_FILE_NAME = ".project_mappings.lock";
const LOCAL_PROJECT_PREFIX = "local-";
const MAPPINGS_FILE_NAME = "project_mappings.json";

export function divmemoryHome(home) {
	return home ?? process.env.DIVMEMORY_HOME ?? join(homedir(), ".divmemory");
}

export function getProjectName(projectId) {
	const localMatch = projectId.match(/^local-[a-f0-9]{12}-(.+)$/);
	if (localMatch) return localMatch[1] ?? projectId;
	const lastSlash = projectId.lastIndexOf("/");
	if (lastSlash >= 0) return projectId.slice(lastSlash + 1);
	return projectId;
}

export function mappingsPath(home) {
	return join(divmemoryHome(home), MAPPINGS_FILE_NAME);
}

export function encodePath(absolutePath) {
	return `-${absolutePath.slice(1).replace(/\//g, "-")}`;
}

function mappingLockPath(home) {
	return join(divmemoryHome(home), LOCK_FILE_NAME);
}

/** Cross-process mutex for read-modify-write; in-process writeChains remains an optimization. */
async function withMappingFileLock(home, fn) {
	const lockPath = mappingLockPath(home);
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 }).catch(() => {});

	const LOCK_STALE_MS = 10000;

	for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
		let handle;
		try {
			handle = await open(lockPath, "wx");
			const metadata = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
			try {
				await handle.writeFile(metadata, "utf-8");
			} catch (writeErr) {
				await handle.close().catch(() => {});
				await unlink(lockPath).catch(() => {});
				throw writeErr;
			}
			try {
				return await fn();
			} finally {
				await handle.close().catch(() => {});
				await unlink(lockPath).catch(() => {});
			}
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;

			let isStale = false;
			try {
				const content = await readFile(lockPath, "utf-8").catch(() => null);
				if (content) {
					const info = JSON.parse(content);
					let pidExists = true;
					if (typeof info.pid !== "number" || !Number.isInteger(info.pid) || info.pid <= 0) {
						pidExists = false;
					} else {
						try {
							process.kill(info.pid, 0);
						} catch (err) {
							if (err?.code === "ESRCH") {
								pidExists = false;
							}
						}
					}
					if (!pidExists) {
						isStale = true;
					}
				} else {
					const st = await stat(lockPath).catch(() => null);
					if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
						isStale = true;
					}
				}
			} catch {
				const st = await stat(lockPath).catch(() => null);
				if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
					isStale = true;
				}
			}

			if (isStale) {
				await unlink(lockPath).catch(() => {});
				continue;
			}

			await new Promise((r) => setTimeout(r, LOCK_BASE_DELAY_MS * (attempt + 1)));
		}
	}
	throw new Error(`[divmemory] Timed out acquiring project mapping lock: ${lockPath}`);
}

export function lookupProjectMapping(absolutePath, options = {}) {
	try {
		const raw = readFileSync(mappingsPath(options.home), "utf-8");
		const mappings = JSON.parse(raw);
		if (typeof mappings !== "object" || mappings === null || Array.isArray(mappings)) {
			return null;
		}
		let mapped = mappings[absolutePath];
		if (typeof mapped !== "string" && absolutePath.startsWith("/")) {
			const encodedKey = encodePath(absolutePath);
			mapped = mappings[encodedKey];
		}
		return typeof mapped === "string" ? mapped : null;
	} catch {
		return null;
	}
}

export function getAllMappingKeys(options = {}) {
	try {
		const raw = readFileSync(mappingsPath(options.home), "utf-8");
		const mappings = JSON.parse(raw);
		if (typeof mappings !== "object" || mappings === null || Array.isArray(mappings)) {
			return [];
		}
		return Object.keys(mappings);
	} catch {
		return [];
	}
}

export function normalizeGitRemote(url) {
	let normalized = url.replace(/\.git$/, "").replace(/\/+$/, "");
	normalized = normalized.toLowerCase();
	normalized = normalized.replace(/^[a-z]+:\/\//, "");
	if (!normalized.startsWith("git@")) {
		normalized = normalized.replace(/^[^@]+@/, "");
	}
	if (normalized.startsWith("git@")) {
		const stripped = normalized.replace(/^git@/, "");
		const colonIndex = stripped.indexOf(":");
		if (colonIndex >= 0) {
			const host = stripped.slice(0, colonIndex);
			const rest = stripped.slice(colonIndex + 1);
			const portMatch = rest.match(/^(\d+)\/(.+)/);
			normalized = portMatch ? `${host}:${portMatch[1]}/${portMatch[2]}` : `${host}/${rest}`;
		} else {
			normalized = stripped;
		}
	}
	return normalized;
}

export async function hasGitOrigin(cwd) {
	try {
		await new Promise((resolvePromise, reject) => {
			const child = spawn(
				"git",
				["-C", resolve(cwd || process.cwd()), "remote", "get-url", "origin"],
				{
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stderr = "";
			child.stderr.on("data", (d) => {
				stderr += d;
			});
			child.on("error", (err) => reject(err));
			child.on("close", (code) => {
				if (code === 0) resolvePromise(undefined);
				else reject(new Error(stderr || `git exited ${code}`));
			});
		});
		return true;
	} catch {
		return false;
	}
}

export function localProjectId(absolutePath) {
	const hash = createHash("sha256").update(absolutePath).digest("hex").slice(0, 12);
	return `${LOCAL_PROJECT_PREFIX}${hash}-${basename(absolutePath)}`;
}

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
		if (!existsSync(absolutePath)) {
			const mapped = lookupProjectMapping(absolutePath, options);
			if (typeof mapped === "string") return mapped;
		}
		return localProjectId(absolutePath);
	}
}

export const getProjectId = resolveProjectId;

const writeChains = new Map();

async function writeProjectMappingUnlocked(absolutePath, projectId, options = {}) {
	const homeKey = divmemoryHome(options.home);
	await withMappingFileLock(homeKey, async () => {
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

		const encodedKey = encodePath(absolutePath);
		if (mappings[absolutePath] === projectId && mappings[encodedKey] === projectId) {
			return;
		}

		mappings[absolutePath] = projectId;

		const tmpPath = `${path}.${randomUUID()}.tmp`;
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(tmpPath, `${JSON.stringify(mappings, null, 2)}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		await rename(tmpPath, path);
	});
}

const LOCAL_FALLBACK_RE = /^local-[a-f0-9]{12}-/;

export function writeProjectMapping(absolutePath, projectId, options = {}) {
	if (LOCAL_FALLBACK_RE.test(projectId)) return Promise.resolve();

	const homeKey = divmemoryHome(options.home);
	const work = (writeChains.get(homeKey) ?? Promise.resolve()).then(() =>
		writeProjectMappingUnlocked(absolutePath, projectId, options),
	);
	const settled = work.catch(() => {});
	writeChains.set(homeKey, settled);
	return settled;
}
