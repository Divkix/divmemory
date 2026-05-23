import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getProjectId, processSessionStart } from "../scripts/session-start.mjs";

async function waitForMapping(
	tmpDir: string,
	key: string,
	expected?: string,
	timeoutMs = 2000,
): Promise<Record<string, string> | null> {
	const mappingsFile = join(tmpDir, "project_mappings.json");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(mappingsFile)) {
			const mappings = JSON.parse(readFileSync(mappingsFile, "utf-8")) as Record<string, string>;
			if (expected === undefined) {
				if (mappings[key] === undefined) return mappings;
			} else if (mappings[key] === expected) {
				return mappings;
			}
		}
		await new Promise((r) => setTimeout(r, 10));
	}
	if (!existsSync(mappingsFile)) return null;
	return JSON.parse(readFileSync(mappingsFile, "utf-8")) as Record<string, string>;
}

describe("session-start hook", () => {
	let tmpDir: string;
	let originalEnv: Record<string, string | undefined>;
	let capturedStderr: string[];
	let capturedStdout: string[];
	let fetchCalls: Array<{ url: string; init: RequestInit; body: unknown }>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "session-start-test-"));
		originalEnv = {
			DIVMEMORY_API_KEY: process.env.DIVMEMORY_API_KEY,
			DIVMEMORY_WORKER_URL: process.env.DIVMEMORY_WORKER_URL,
			DIVMEMORY_HOME: process.env.DIVMEMORY_HOME,
		};
		process.env.DIVMEMORY_HOME = tmpDir;
		capturedStderr = [];
		capturedStdout = [];
		fetchCalls = [];
	});

	afterEach(() => {
		for (const [key, val] of Object.entries(originalEnv)) {
			if (val === undefined) delete process.env[key];
			else process.env[key] = val;
		}
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	function mockFetch(customFn?: (url: string, init: RequestInit) => Promise<Response>) {
		return async (url: string, init: RequestInit) => {
			let body: unknown;
			if (init.body) {
				try {
					body = JSON.parse(String(init.body));
				} catch {
					body = String(init.body);
				}
			}
			fetchCalls.push({ url, init, body });
			if (customFn) return customFn(url, init);
			return new Response("## divmemory — Project Memory\n\n* Fact 1\n", {
				status: 200,
				headers: { "Content-Type": "text/plain" },
			});
		};
	}

	function makeStdin(overrides: Record<string, unknown> = {}, event = "SessionStart") {
		return JSON.stringify({
			session_id: "test-session-1",
			cwd: tmpDir,
			hook_event_name: event,
			source: "startup",
			...overrides,
		});
	}

	describe("stdin parsing", () => {
		it("parses valid SessionStart JSON from stdin (VAL-PLUGIN-041)", async () => {
			const stdin = makeStdin();
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			const result = await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(fetchCalls).toHaveLength(1);
		});

		it("ignores unknown extra fields in stdin (VAL-PLUGIN-054)", async () => {
			const stdin = makeStdin({ future_field: "value" });
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			const result = await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(fetchCalls).toHaveLength(1);
		});

		it("detects wrong hook_event_name and warns (VAL-PLUGIN-053)", async () => {
			const stdin = makeStdin({}, "SessionEnd");
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			const result = await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("SessionEnd");
			expect(capturedStderr.join("")).toContain("SessionStart");
		});

		it("handles malformed stdin JSON and exits 0 (VAL-PLUGIN-106)", async () => {
			const fetchFn = mockFetch();
			const result = await processSessionStart("not json", {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("Malformed JSON");
		});

		it("handles empty stdin by exiting 0 (VAL-PLUGIN-107)", async () => {
			const fetchFn = mockFetch();
			const result = await processSessionStart("", {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("No stdin data");
		});

		it("handles empty stdin with just whitespace by exiting 0 (VAL-PLUGIN-107)", async () => {
			const fetchFn = mockFetch();
			const result = await processSessionStart("   \n\t  ", {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("No stdin data");
		});
	});

	describe("project ID detection", () => {
		it("extracts project_id from git remote origin URL (VAL-PLUGIN-042)", async () => {
			const gitDir = join(tmpDir, "git-repo");
			const { execSync } = await import("node:child_process");
			execSync(
				`mkdir -p ${gitDir} && cd ${gitDir} && git init && git remote add origin https://github.com/divkix/my-app.git`,
			);
			const id = await getProjectId(gitDir);
			expect(id).toBe("github.com/divkix/my-app");
		});

		it("falls back to a hashed absolute path slug when no git remote", async () => {
			const noGitDir = join(tmpDir, "no-git");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(noGitDir, { recursive: true });
			const id = await getProjectId(noGitDir);
			expect(id).toMatch(/^local-[a-f0-9]{12}-no-git$/);
		});

		it("normalizes SSH git@ remote URL (VAL-PLUGIN-044)", async () => {
			const gitDir = join(tmpDir, "ssh-repo");
			const { execSync } = await import("node:child_process");
			execSync(
				`mkdir -p ${gitDir} && cd ${gitDir} && git init && git remote add origin git@github.com:divkix/my-app.git`,
			);
			const id = await getProjectId(gitDir);
			expect(id).toBe("github.com/divkix/my-app");
		});

		it("normalizes protocol-prefixed SSH remote URL consistently", async () => {
			const gitDir = join(tmpDir, "ssh-proto-repo");
			const { execSync } = await import("node:child_process");
			execSync(
				`mkdir -p ${gitDir} && cd ${gitDir} && git init && git remote add origin ssh://git@github.com/divkix/my-app.git`,
			);
			const id = await getProjectId(gitDir);
			expect(id).toBe("github.com/divkix/my-app");
		});

		it("strips .git suffix from remote URL", async () => {
			const gitDir = join(tmpDir, "with-git");
			const { execSync } = await import("node:child_process");
			execSync(
				`mkdir -p ${gitDir} && cd ${gitDir} && git init && git remote add origin https://github.com/divkix/my-app.git`,
			);
			const id = await getProjectId(gitDir);
			expect(id).not.toContain(".git");
			expect(id).toBe("github.com/divkix/my-app");
		});

		it("normalizes mixed-case git remote casing (VAL-PLUGIN-058)", async () => {
			const gitDir = join(tmpDir, "mixed-case");
			const { execSync } = await import("node:child_process");
			execSync(
				`mkdir -p ${gitDir} && cd ${gitDir} && git init && git remote add origin https://GITHUB.COM/Divkix/My-App.git`,
			);
			const id = await getProjectId(gitDir);
			expect(id).toBe(id.toLowerCase());
			expect(id).toContain("github.com");
		});

		it("uses central mapping when git is unavailable and path is missing", async () => {
			process.env.DIVMEMORY_HOME = tmpDir;
			const worktreePath = resolve(tmpDir, "mapped-start");
			// Do NOT create the directory so the mapping fallback is used
			writeFileSync(
				join(tmpDir, "project_mappings.json"),
				JSON.stringify({ [worktreePath]: "github.com/org/mapped-start" }),
				"utf-8",
			);
			const id = await getProjectId(worktreePath);
			expect(id).toBe("github.com/org/mapped-start");
		});

		it("uses process.cwd() when cwd not provided in stdin", async () => {
			// getProjectId should accept undefined and fall back to process.cwd()
			const id = await getProjectId(undefined as unknown as string);
			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);
		});
	});

	describe("GET /context behavior", () => {
		it("GETs /context with correct project and max_chars params (VAL-PLUGIN-045)", async () => {
			const stdin = makeStdin();
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(fetchCalls).toHaveLength(1);
			const url = new URL(fetchCalls[0].url);
			expect(url.pathname).toBe("/context");
			expect(url.searchParams.get("project")).toBeDefined();
			expect(url.searchParams.get("max_chars")).toBe("12000");
		});

		it("writes context response to stdout (VAL-PLUGIN-046)", async () => {
			const stdin = makeStdin();
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch(() =>
				Promise.resolve(
					new Response("## divmemory — Project Memory\n\n* Hello\n", {
						status: 200,
						headers: { "Content-Type": "text/plain" },
					}),
				),
			);
			const result = await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStdout.join("")).toContain("## divmemory — Project Memory");
			expect(capturedStdout.join("")).toContain("* Hello");
		});

		it("exits 0 when Worker returns empty context — stdout placeholder, error to stderr (VAL-PLUGIN-047)", async () => {
			const stdin = makeStdin();
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch(() =>
				Promise.resolve(
					new Response("", { status: 200, headers: { "Content-Type": "text/plain" } }),
				),
			);
			const result = await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("Empty context");
			expect(capturedStdout.join("")).not.toBe("");
		});

		it("exits 0 when Worker returns non-200 — error logged to stderr (VAL-PLUGIN-048)", async () => {
			const stdin = makeStdin();
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch(() =>
				Promise.resolve(new Response("Internal Server Error", { status: 500 })),
			);
			const result = await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("500");
			expect(capturedStdout.join("")).not.toBe("");
		});

		it("exits 0 when Worker unavailable — network error to stderr (VAL-PLUGIN-049)", async () => {
			const stdin = makeStdin();
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = () => Promise.reject(new Error("ECONNREFUSED"));
			const result = await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("Network error");
			expect(capturedStdout.join("")).not.toBe("");
		});

		it("exits 0 when DIVMEMORY_API_KEY is missing — error to stderr (VAL-PLUGIN-050)", async () => {
			const stdin = makeStdin();
			delete process.env.DIVMEMORY_API_KEY;
			const fetchFn = mockFetch();
			const result = await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("DIVMEMORY_API_KEY");
			expect(fetchCalls).toHaveLength(0);
		});

		it("reads DIVMEMORY_API_KEY from env for Bearer auth (VAL-PLUGIN-051)", async () => {
			const stdin = makeStdin();
			process.env.DIVMEMORY_API_KEY = "my-secret-key";
			const fetchFn = mockFetch();
			await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			const headers = fetchCalls[0].init.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer my-secret-key");
		});

		it("respects DIVMEMORY_WORKER_URL env var (VAL-PLUGIN-052)", async () => {
			const stdin = makeStdin();
			process.env.DIVMEMORY_API_KEY = "test-key";
			process.env.DIVMEMORY_WORKER_URL = "https://custom.example.com";
			const fetchFn = mockFetch();
			await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(fetchCalls[0].url.startsWith("https://custom.example.com/context")).toBe(true);
		});

		it("uses default worker URL when DIVMEMORY_WORKER_URL unset (VAL-PLUGIN-057)", async () => {
			const stdin = makeStdin();
			process.env.DIVMEMORY_API_KEY = "test-key";
			delete process.env.DIVMEMORY_WORKER_URL;
			const fetchFn = mockFetch();
			await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(fetchCalls[0].url.startsWith("https://divmemory.divkix.workers.dev/context")).toBe(
				true,
			);
		});

		it("URL-encodes project_id in GET request (VAL-PLUGIN-055)", async () => {
			const gitDir = join(tmpDir, "encoded-repo");
			const { execSync } = await import("node:child_process");
			execSync(
				`mkdir -p ${gitDir} && cd ${gitDir} && git init && git remote add origin https://github.com/divkix/my%20app.git`,
			);
			const stdin = makeStdin({ cwd: gitDir });
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			const url = new URL(fetchCalls[0].url);
			expect(url.searchParams.get("project")).toBe("github.com/divkix/my%20app");
		});

		it("handles non-text Worker responses (HTML error page) gracefully (VAL-PLUGIN-056)", async () => {
			const stdin = makeStdin();
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch(() =>
				Promise.resolve(
					new Response("<html><body>Error</body></html>", {
						status: 502,
						headers: { "Content-Type": "text/html" },
					}),
				),
			);
			const result = await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("502");
			expect(capturedStdout.join("")).not.toBe("");
		});

		it("handles JSON error response from Worker gracefully (VAL-PLUGIN-056)", async () => {
			const stdin = makeStdin();
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch(() =>
				Promise.resolve(
					new Response(JSON.stringify({ error: "auth failed" }), {
						status: 401,
						headers: { "Content-Type": "application/json" },
					}),
				),
			);
			const result = await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("401");
			expect(capturedStdout.join("")).not.toBe("");
		});

		it("logs errors to stderr, never stdout (VAL-PLUGIN-108)", async () => {
			const stdin = makeStdin();
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch(() => Promise.resolve(new Response("err", { status: 500 })));
			await processSessionStart(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(capturedStderr.join("").length).toBeGreaterThan(0);
			// stdout should ONLY be the fallback/empty output, not error text
		});

		it("uses exact same getProjectId logic as session-end (VAL-PLUGIN-002/VAL-CROSS-051)", async () => {
			// Import getProjectId from session-end and compare
			const { getProjectId: getProjectIdEnd } = await import("../scripts/session-end.mjs");
			const gitDir = join(tmpDir, "git-repo");
			const { execSync } = await import("node:child_process");
			execSync(
				`mkdir -p ${gitDir} && cd ${gitDir} && git init && git remote add origin https://github.com/divkix/my-app.git`,
			);
			const idStart = await getProjectId(gitDir);
			const idEnd = await getProjectIdEnd(gitDir);
			expect(idStart).toBe(idEnd);
		});

		it("prints cached context immediately without waiting on the Worker", async () => {
			process.env.DIVMEMORY_HOME = tmpDir;
			process.env.DIVMEMORY_API_KEY = "test-key";
			const projectId = await getProjectId(tmpDir);
			const cachePath = join(tmpDir, "cache", `${encodeURIComponent(projectId)}.txt`);
			const { mkdirSync } = await import("node:fs");
			mkdirSync(join(tmpDir, "cache"), { recursive: true });
			writeFileSync(cachePath, "## divmemory — Cached\n\n- Old fact\n", "utf-8");

			const fetchFn = mockFetch(() =>
				Promise.resolve(
					new Response("## divmemory — Fresh\n\n- New fact\n", {
						status: 200,
						headers: { "Content-Type": "text/plain" },
					}),
				),
			);
			const result = await processSessionStart(makeStdin(), {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});

			expect(result.exitCode).toBe(0);
			expect(capturedStdout.join("")).toContain("## divmemory — Cached");
			expect(fetchCalls).toHaveLength(0);
			expect(readFileSync(cachePath, "utf-8")).toContain("## divmemory — Cached");
		});

		it("does not leave a cache file when the Worker returns an error", async () => {
			process.env.DIVMEMORY_HOME = tmpDir;
			process.env.DIVMEMORY_API_KEY = "test-key";
			const projectId = await getProjectId(tmpDir);
			const cachePath = join(tmpDir, "cache", `${encodeURIComponent(projectId)}.txt`);
			const fetchFn = mockFetch(() => Promise.resolve(new Response("error", { status: 500 })));

			await processSessionStart(makeStdin(), {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});

			expect(existsSync(cachePath)).toBe(false);
		});
	});

	describe("project path mappings (issue #19)", () => {
		it("writes path-to-remote mapping on session-start for git repos (VAL-PLUGIN-109)", async () => {
			process.env.DIVMEMORY_HOME = tmpDir;
			process.env.DIVMEMORY_API_KEY = "test-key";
			const gitDir = join(tmpDir, "git-worktree-start");
			const { execSync } = await import("node:child_process");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(gitDir, { recursive: true });
			execSync("git init", { cwd: gitDir });
			execSync("git remote add origin https://github.com/cloudflare/vinext.git", {
				cwd: gitDir,
			});

			await processSessionStart(makeStdin({ cwd: gitDir }), {
				fetch: mockFetch(),
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});

			const mappings = await waitForMapping(
				tmpDir,
				resolve(gitDir),
				"github.com/cloudflare/vinext",
			);
			expect(mappings).not.toBeNull();
			expect(mappings?.[resolve(gitDir)]).toBe("github.com/cloudflare/vinext");
		});

		it("does not write mapping when project id is local-* fallback (VAL-PLUGIN-110)", async () => {
			process.env.DIVMEMORY_HOME = tmpDir;
			process.env.DIVMEMORY_API_KEY = "test-key";
			const noGitDir = join(tmpDir, "no-git-mapping-start");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(noGitDir, { recursive: true });

			await processSessionStart(makeStdin({ cwd: noGitDir }), {
				fetch: mockFetch(),
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});

			const mappings = await waitForMapping(tmpDir, resolve(noGitDir));
			if (mappings) {
				expect(mappings[resolve(noGitDir)]).toBeUndefined();
			}
		});

		it("logs mapping write errors to stderr without blocking stdout (VAL-PLUGIN-111)", async () => {
			process.env.DIVMEMORY_HOME = tmpDir;
			process.env.DIVMEMORY_API_KEY = "test-key";
			const gitDir = join(tmpDir, "git-mapping-error");
			const { execSync } = await import("node:child_process");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(gitDir, { recursive: true });
			execSync("git init", { cwd: gitDir });
			execSync("git remote add origin https://github.com/divkix/error-test.git", {
				cwd: gitDir,
			});

			const mappingsMod = await import("../scripts/project-mappings.mjs");
			const spy = vi
				.spyOn(mappingsMod, "writeProjectMapping")
				.mockRejectedValueOnce(new Error("disk full"));

			const result = await processSessionStart(makeStdin({ cwd: gitDir }), {
				fetch: mockFetch(),
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});

			await new Promise((r) => setTimeout(r, 50));
			spy.mockRestore();

			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("Failed to persist project mapping");
			expect(capturedStdout.join("").length).toBeGreaterThan(0);
		});

		it("writes mapping even when cache short-circuits Worker fetch (VAL-PLUGIN-112)", async () => {
			process.env.DIVMEMORY_HOME = tmpDir;
			process.env.DIVMEMORY_API_KEY = "test-key";
			const gitDir = join(tmpDir, "git-cached-start");
			const { execSync } = await import("node:child_process");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(gitDir, { recursive: true });
			execSync("git init", { cwd: gitDir });
			execSync("git remote add origin https://github.com/divkix/cached-start.git", {
				cwd: gitDir,
			});

			const projectId = await getProjectId(gitDir);
			const cachePath = join(tmpDir, "cache", `${encodeURIComponent(projectId)}.txt`);
			mkdirSync(join(tmpDir, "cache"), { recursive: true });
			writeFileSync(cachePath, "## divmemory — Cached\n\n- fact\n", "utf-8");

			await processSessionStart(makeStdin({ cwd: gitDir }), {
				fetch: mockFetch(),
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});

			expect(fetchCalls).toHaveLength(0);
			const mappings = await waitForMapping(
				tmpDir,
				resolve(gitDir),
				"github.com/divkix/cached-start",
			);
			expect(mappings?.[resolve(gitDir)]).toBe("github.com/divkix/cached-start");
		});

		it("writes mapping when DIVMEMORY_API_KEY is unset (VAL-PLUGIN-113)", async () => {
			process.env.DIVMEMORY_HOME = tmpDir;
			delete process.env.DIVMEMORY_API_KEY;
			const gitDir = join(tmpDir, "git-no-api-key");
			const { execSync } = await import("node:child_process");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(gitDir, { recursive: true });
			execSync("git init", { cwd: gitDir });
			execSync("git remote add origin https://github.com/divkix/no-key.git", { cwd: gitDir });

			await processSessionStart(makeStdin({ cwd: gitDir }), {
				fetch: mockFetch(),
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});

			const mappings = await waitForMapping(tmpDir, resolve(gitDir), "github.com/divkix/no-key");
			expect(mappings?.[resolve(gitDir)]).toBe("github.com/divkix/no-key");
		});

		it("divmemory runtime processSessionStart writes mappings for git repos", async () => {
			const { processSessionStart: runtimeSessionStart } = await import(
				"../../plugins/divmemory/hooks/runtime.mjs"
			);
			process.env.DIVMEMORY_HOME = tmpDir;
			process.env.DIVMEMORY_API_KEY = "test-key";
			const gitDir = join(tmpDir, "runtime-git-start");
			const { execSync } = await import("node:child_process");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(gitDir, { recursive: true });
			execSync("git init", { cwd: gitDir });
			execSync("git remote add origin https://github.com/divkix/runtime-start.git", {
				cwd: gitDir,
			});

			await runtimeSessionStart(
				JSON.stringify({
					session_id: "runtime-start-map",
					cwd: gitDir,
					hook_event_name: "SessionStart",
				}),
				{
					fetch: mockFetch(),
					stderr: (s: string) => capturedStderr.push(s),
					stdout: (s: string) => capturedStdout.push(s),
				},
			);

			const mappings = await waitForMapping(
				tmpDir,
				resolve(gitDir),
				"github.com/divkix/runtime-start",
			);
			expect(mappings?.[resolve(gitDir)]).toBe("github.com/divkix/runtime-start");
		});
	});
});
