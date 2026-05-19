import { describe, expect, it } from "vitest";
import { workerUrl } from "./index";

// Temporary tests for worker URL propagation
// Real CLI tests will be added by feature bootstrap-cli
describe("cli worker url", () => {
	it("exports a workerUrl default", () => {
		expect(typeof workerUrl).toBe("string");
		expect(workerUrl.length).toBeGreaterThan(0);
		expect(workerUrl).toContain("divmemory");
	});
});
