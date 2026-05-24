// Bootstrap CLI entrypoint
// Reads DIVMEMORY_WORKER_URL env var for the Worker base URL.
// Falls back to the default production URL when unset.
const DEFAULT_WORKER_URL = "https://divmemory.divkix.workers.dev";
const envUrl = process.env.DIVMEMORY_WORKER_URL;
export const workerUrl =
	envUrl && envUrl !== "undefined" && envUrl !== "null" ? envUrl : DEFAULT_WORKER_URL;
