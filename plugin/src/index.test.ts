import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	encodePath,
	lookupProjectMapping,
	mappingsPath,
	normalizeGitRemote,
} from "../scripts/project-mappings.mjs";

describe("encodePath", () => {
	it("should encode an absolute path to the dash-prefixed format", () => {
		expect(encodePath("/Users/div/projects/my-app")).toBe("-Users-div-projects-my-app");
	});

	it("should handle paths with literal dashes correctly", () => {
		expect(encodePath("/Users/div/worktrees/vinext-earnest")).toBe(
			"-Users-div-worktrees-vinext-earnest",
		);
	});

	it("should handle root-level paths", () => {
		expect(encodePath("/home/user")).toBe("-home-user");
	});
});

describe("lookupProjectMapping", () => {
	it("does not encode relative paths for fallback lookups", () => {
		const home = mkdtempSync(join(tmpdir(), "divmemory-mapping-"));
		writeFileSync(
			mappingsPath(home),
			JSON.stringify({ [encodePath("relative/project")]: "github.com/wrong/project" }),
			"utf-8",
		);

		expect(lookupProjectMapping("relative/project", { home })).toBeNull();
	});

	it("uses encoded fallback lookups for absolute paths", () => {
		const home = mkdtempSync(join(tmpdir(), "divmemory-mapping-"));
		const absolutePath = "/Users/div/projects/my-app";
		writeFileSync(
			mappingsPath(home),
			JSON.stringify({ [encodePath(absolutePath)]: "github.com/div/my-app" }),
			"utf-8",
		);

		expect(lookupProjectMapping(absolutePath, { home })).toBe("github.com/div/my-app");
	});
});

describe("normalizeGitRemote", () => {
	it("should correctly normalize standard Git URLs", () => {
		expect(normalizeGitRemote("https://github.com/cloudflare/vinext.git")).toBe(
			"github.com/cloudflare/vinext",
		);
		expect(normalizeGitRemote("git@github.com:org/repo.git")).toBe("github.com/org/repo");
	});

	it("should preserve ports in SSH URLs with custom ports", () => {
		expect(normalizeGitRemote("ssh://git@host:2222/org/repo.git")).toBe("host:2222/org/repo");
		expect(normalizeGitRemote("git@host:2222/org/repo.git")).toBe("host/2222/org/repo");
	});

	it("should strip userinfo from ssh:// protocol URLs", () => {
		expect(normalizeGitRemote("ssh://deploy@git.example.com/team/repo.git")).toBe(
			"git.example.com/team/repo",
		);
	});

	it("should strip git@ prefix and convert single colon host paths", () => {
		expect(normalizeGitRemote("git@github.com:my-org/my-repo")).toBe("github.com/my-org/my-repo");
	});
});
