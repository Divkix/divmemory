export const DEFAULT_WORKER_URL = "https://divmemory.divkix.workers.dev";

export function resolveWorkerUrl(raw = process.env.DIVMEMORY_WORKER_URL) {
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : DEFAULT_WORKER_URL;
}
