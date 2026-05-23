import { describe, expect, it } from "vitest";
import { normalizeGitRemote } from "../scripts/project-mappings.mjs";

describe("normalizeGitRemote", () => {
	it("should correctly normalize standard Git URLs", () => {
		expect(normalizeGitRemote("https://github.com/cloudflare/vinext.git")).toBe(
			"github.com/cloudflare/vinext",
		);
		expect(normalizeGitRemote("git@github.com:org/repo.git")).toBe("github.com/org/repo");
	});

	it("should preserve ports in SSH URLs with custom ports", () => {
		expect(normalizeGitRemote("ssh://git@host:2222/org/repo.git")).toBe("host:2222/org/repo");
		expect(normalizeGitRemote("git@host:2222/org/repo.git")).toBe("host:2222/org/repo");
	});

	it("should strip git@ prefix and convert single colon host paths", () => {
		expect(normalizeGitRemote("git@github.com:my-org/my-repo")).toBe("github.com/my-org/my-repo");
	});
});
