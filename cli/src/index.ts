// Bootstrap CLI entrypoint
// Reads DIVMEMORY_WORKER_URL env var for the Worker base URL.
// Falls back to the default production URL when unset.
const DEFAULT_WORKER_URL = "https://divmemory.divkix.workers.dev";
export const workerUrl = process.env.DIVMEMORY_WORKER_URL || DEFAULT_WORKER_URL;
