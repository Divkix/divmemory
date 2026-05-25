// Bootstrap CLI entrypoint
// Reads DIVMEMORY_WORKER_URL env var for the Worker base URL.
// Falls back to the default production URL when unset.
import { resolveWorkerUrl } from "@divmemory/plugin/config";

export const workerUrl = resolveWorkerUrl();
