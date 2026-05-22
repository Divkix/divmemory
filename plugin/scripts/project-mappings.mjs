import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function divmemoryHome(home) {
	return home ?? process.env.DIVMEMORY_HOME ?? join(homedir(), ".divmemory");
}

export function mappingsPath(home) {
	return join(divmemoryHome(home), "project_mappings.json");
}

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
