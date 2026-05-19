import { describe, expect, it } from "vitest";
import defaultExport from "./index";

describe("worker entry point exports", () => {
	it("exports an object with fetch handler for HTTP requests", () => {
		expect(typeof defaultExport).toBe("object");
		expect(defaultExport).toHaveProperty("fetch");
		expect(typeof defaultExport.fetch).toBe("function");
	});

	it("exports a scheduled handler for cron events", () => {
		expect(defaultExport).toHaveProperty("scheduled");
		expect(typeof defaultExport.scheduled).toBe("function");
	});
});
