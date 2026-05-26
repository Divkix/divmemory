import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WORKER_URL, resolveWorkerUrl } from "./config.mjs";

describe("resolveWorkerUrl", () => {
	let oldEnv: string | undefined;

	beforeEach(() => {
		oldEnv = process.env.DIVMEMORY_WORKER_URL;
		delete process.env.DIVMEMORY_WORKER_URL;
	});

	afterEach(() => {
		if (oldEnv === undefined) {
			delete process.env.DIVMEMORY_WORKER_URL;
		} else {
			process.env.DIVMEMORY_WORKER_URL = oldEnv;
		}
	});

	it("falls back for unset and blank values", () => {
		expect(resolveWorkerUrl(undefined)).toBe(DEFAULT_WORKER_URL);
		expect(resolveWorkerUrl("")).toBe(DEFAULT_WORKER_URL);
		expect(resolveWorkerUrl(" \t\n ")).toBe(DEFAULT_WORKER_URL);
	});

	it("falls back for shell-literal empty environment values", () => {
		expect(resolveWorkerUrl("undefined")).toBe(DEFAULT_WORKER_URL);
		expect(resolveWorkerUrl("null")).toBe(DEFAULT_WORKER_URL);
	});

	it("trims configured URLs", () => {
		expect(resolveWorkerUrl(" https://custom.example.com ")).toBe("https://custom.example.com");
	});
});
