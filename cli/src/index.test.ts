import { afterEach, describe, expect, it } from "vitest";

const DEFAULT_WORKER_URL = "https://divmemory.divkix.workers.dev";
const originalWorkerUrl = process.env.DIVMEMORY_WORKER_URL;

async function loadWorkerUrl() {
	const mod = await import(`./index.ts?case=${crypto.randomUUID()}`);
	return mod.workerUrl as string;
}

afterEach(() => {
	if (originalWorkerUrl === undefined) {
		delete process.env.DIVMEMORY_WORKER_URL;
	} else {
		process.env.DIVMEMORY_WORKER_URL = originalWorkerUrl;
	}
});

describe("workerUrl", () => {
	it("falls back for whitespace-only DIVMEMORY_WORKER_URL", async () => {
		process.env.DIVMEMORY_WORKER_URL = " \t\n ";

		await expect(loadWorkerUrl()).resolves.toBe(DEFAULT_WORKER_URL);
	});

	it("trims configured DIVMEMORY_WORKER_URL", async () => {
		process.env.DIVMEMORY_WORKER_URL = " https://custom.example.com ";

		await expect(loadWorkerUrl()).resolves.toBe("https://custom.example.com");
	});
});
