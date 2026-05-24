import { DEFAULT_WORKER_URL, resolveWorkerUrl } from "@divmemory/plugin/config";
import { describe, expect, it } from "vitest";
import { workerUrl } from "./index";

describe("workerUrl", () => {
	it("exports the resolved worker URL", () => {
		expect(typeof workerUrl).toBe("string");
		expect(workerUrl.length).toBeGreaterThan(0);
	});

	it("falls back for whitespace-only DIVMEMORY_WORKER_URL", () => {
		expect(resolveWorkerUrl(" \t\n ")).toBe(DEFAULT_WORKER_URL);
	});

	it("trims configured DIVMEMORY_WORKER_URL", () => {
		expect(resolveWorkerUrl(" https://custom.example.com ")).toBe("https://custom.example.com");
	});
});
