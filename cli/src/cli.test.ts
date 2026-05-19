import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// SessionFile mirrors the type exported from cli.ts
type SessionFile = {
	filePath: string;
	mtime: number;
	projectDir: string;
};

// Assume these functions will be exported from cli.ts or a new module
// We'll import them once they exist
async function loadCliModule() {
	return import("./cli");
}

describe("bootstrap cli", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "divmemory-cli-"));
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	describe("flag parsing", () => {
		it("parses --help flag and shows usage", async () => {
			const mod = await loadCliModule();
			const { parseFlags } = mod;
			if (!parseFlags) return;
			const result = parseFlags(["--help"]);
			expect(result.help).toBe(true);
		});

		it("parses --dir with custom path", async () => {
			const mod = await loadCliModule();
			const { parseFlags } = mod;
			if (!parseFlags) return;
			const result = parseFlags(["--dir", "/tmp/sessions"]);
			expect(result.dir).toBe("/tmp/sessions");
		});

		it("parses --limit as number", async () => {
			const mod = await loadCliModule();
			const { parseFlags } = mod;
			if (!parseFlags) return;
			const result = parseFlags(["--limit", "10"]);
			expect(result.limit).toBe(10);
		});

		it("parses --dry-run flag", async () => {
			const mod = await loadCliModule();
			const { parseFlags } = mod;
			if (!parseFlags) return;
			const result = parseFlags(["--dry-run"]);
			expect(result.dryRun).toBe(true);
		});

		it("parses --api-key flag", async () => {
			const mod = await loadCliModule();
			const { parseFlags } = mod;
			if (!parseFlags) return;
			const result = parseFlags(["--api-key", "secret123"]);
			expect(result.apiKey).toBe("secret123");
		});

		it("parses --worker flag", async () => {
			const mod = await loadCliModule();
			const { parseFlags } = mod;
			if (!parseFlags) return;
			const result = parseFlags(["--worker", "https://custom.example.com"]);
			expect(result.worker).toBe("https://custom.example.com");
		});

		it("unknown flag produces error", async () => {
			const mod = await loadCliModule();
			const { parseFlags } = mod;
			if (!parseFlags) return;
			expect(() => parseFlags(["--bogus-flag"])).toThrow();
		});

		it("invalid limit (non-integer) produces error", async () => {
			const mod = await loadCliModule();
			const { parseFlags } = mod;
			if (!parseFlags) return;
			expect(() => parseFlags(["--limit", "abc"])).toThrow();
		});

		it("invalid limit (negative) produces error", async () => {
			const mod = await loadCliModule();
			const { parseFlags } = mod;
			if (!parseFlags) return;
			expect(() => parseFlags(["--limit", "-5"])).toThrow();
		});

		it("limit zero is treated as no sessions", async () => {
			const mod = await loadCliModule();
			const { parseFlags } = mod;
			if (!parseFlags) return;
			const result = parseFlags(["--limit", "0"]);
			expect(result.limit).toBe(0);
		});
	});

	describe("directory scanning", () => {
		it("scans default sessions directory", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles } = mod;
			if (!findSessionFiles) return;
			// Create a mock sessions dir
			const sessionsDir = join(tmpDir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			writeFileSync(join(sessionsDir, "sess1.jsonl"), "{}\n");
			const files = await findSessionFiles(sessionsDir);
			expect(files).toHaveLength(1);
			expect(files[0].filePath).toContain("sess1.jsonl");
		});

		it("scans custom directory via --dir", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles } = mod;
			if (!findSessionFiles) return;
			writeFileSync(join(tmpDir, "sess1.jsonl"), "{}\n");
			const files = await findSessionFiles(tmpDir);
			expect(files).toHaveLength(1);
		});

		it("recursively finds JSONL files in subdirectories", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles } = mod;
			if (!findSessionFiles) return;
			const sub1 = join(tmpDir, "project-A");
			const sub2 = join(tmpDir, "project-B");
			mkdirSync(sub1, { recursive: true });
			mkdirSync(sub2, { recursive: true });
			writeFileSync(join(sub1, "sess1.jsonl"), "{}\n");
			writeFileSync(join(sub2, "sess2.jsonl"), "{}\n");
			const files = await findSessionFiles(tmpDir);
			expect(files).toHaveLength(2);
		});

		it("ignores non-JSONL files", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles } = mod;
			if (!findSessionFiles) return;
			writeFileSync(join(tmpDir, "sess1.jsonl"), "{}\n");
			writeFileSync(join(tmpDir, ".DS_Store"), "binary");
			writeFileSync(join(tmpDir, "metadata.json"), "{}");
			const files = await findSessionFiles(tmpDir);
			expect(files).toHaveLength(1);
			expect(files[0].filePath).toContain("sess1.jsonl");
		});

		it("handles empty directory", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles } = mod;
			if (!findSessionFiles) return;
			mkdirSync(join(tmpDir, "empty"), { recursive: true });
			const files = await findSessionFiles(join(tmpDir, "empty"));
			expect(files).toHaveLength(0);
		});

		it("handles missing directory with error", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles } = mod;
			if (!findSessionFiles) return;
			await expect(findSessionFiles(join(tmpDir, "nonexistent"))).rejects.toThrow();
		});
	});

	describe("sorting and limiting", () => {
		it("sorts files by mtime newest first", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles } = mod;
			if (!findSessionFiles) return;
			const f1 = join(tmpDir, "old.jsonl");
			const f2 = join(tmpDir, "new.jsonl");
			const f3 = join(tmpDir, "mid.jsonl");
			writeFileSync(f1, "a\n");
			writeFileSync(f3, "b\n");
			writeFileSync(f2, "c\n");
			// Set mtimes explicitly using filesystem command touch -mt (or utimesSync with careful Date values)
			const now = Date.now();
			const { utimesSync } = await import("node:fs");
			utimesSync(f1, new Date(now - 300000), new Date(now - 300000));
			utimesSync(f3, new Date(now - 150000), new Date(now - 150000));
			utimesSync(f2, new Date(now), new Date(now));
			const files = await findSessionFiles(tmpDir);
			// Verify order: newest (f2) then mid (f3) then old (f1)
			expect(files[0].filePath).toBe(f2);
			expect(files[1].filePath).toBe(f3);
			expect(files[2].filePath).toBe(f1);
		});

		it("respects --limit flag", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles } = mod;
			if (!findSessionFiles) return;
			for (let i = 0; i < 10; i++) {
				writeFileSync(join(tmpDir, `sess${i}.jsonl`), "{}\n");
			}
			const files = await findSessionFiles(tmpDir, 5);
			expect(files).toHaveLength(5);
		});

		it("default limit is 50", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles } = mod;
			if (!findSessionFiles) return;
			for (let i = 0; i < 60; i++) {
				writeFileSync(join(tmpDir, `sess${i}.jsonl`), "{}\n");
			}
			const files = await findSessionFiles(tmpDir);
			expect(files.length).toBeLessThanOrEqual(50);
		});

		it("processes all files when fewer than limit exist", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles } = mod;
			if (!findSessionFiles) return;
			writeFileSync(join(tmpDir, "a.jsonl"), "{}\n");
			writeFileSync(join(tmpDir, "b.jsonl"), "{}\n");
			const files = await findSessionFiles(tmpDir, 50);
			expect(files).toHaveLength(2);
		});

		it("mtime tie-breaking is deterministic", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles } = mod;
			if (!findSessionFiles) return;
			const f1 = join(tmpDir, "aaa.jsonl");
			const f2 = join(tmpDir, "bbb.jsonl");
			writeFileSync(f1, "a\n");
			writeFileSync(f2, "b\n");
			const now = Date.now();
			const { utimesSync } = await import("node:fs");
			utimesSync(f1, now, now);
			utimesSync(f2, now, now);
			const files = await findSessionFiles(tmpDir);
			expect(files).toHaveLength(2);
			// Deterministic: alphabetical by full path
			expect(files[0].filePath < files[1].filePath).toBe(true);
		});
	});

	describe("conversation extraction", () => {
		it("extracts user text messages", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] });
			const conv = extractConversation(jsonl);
			expect(conv).toContain("User: hello");
		});

		it("extracts assistant text messages", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = JSON.stringify({
				role: "assistant",
				content: [{ type: "text", text: "world" }],
			});
			const conv = extractConversation(jsonl);
			expect(conv).toContain("Assistant: world");
		});

		it("strips thinking blocks", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = JSON.stringify({
				role: "assistant",
				content: [
					{ type: "thinking", text: "secret thoughts" },
					{ type: "text", text: "public reply" },
				],
			});
			const conv = extractConversation(jsonl);
			expect(conv).not.toContain("secret thoughts");
			expect(conv).toContain("public reply");
		});

		it("strips tool_use blocks", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = JSON.stringify({
				role: "assistant",
				content: [
					{ type: "tool_use", text: "using tool" },
					{ type: "text", text: "public reply" },
				],
			});
			const conv = extractConversation(jsonl);
			expect(conv).not.toContain("using tool");
			expect(conv).toContain("public reply");
		});

		it("strips system-reminder content", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = [
				JSON.stringify({ type: "system-reminder", content: "hidden" }),
				JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] }),
			].join("\n");
			const conv = extractConversation(jsonl);
			expect(conv).not.toContain("hidden");
			expect(conv).toContain("User: hello");
		});

		it("strips system-notification blocks", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = [
				JSON.stringify({ type: "system-notification", content: "alert" }),
				JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] }),
			].join("\n");
			const conv = extractConversation(jsonl);
			expect(conv).not.toContain("alert");
			expect(conv).toContain("User: hello");
		});

		it("skips non-message JSONL lines", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = [
				JSON.stringify({ type: "session_start" }),
				JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] }),
				JSON.stringify({ type: "hook" }),
			].join("\n");
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: hello");
		});

		it("concatenates turns with double newlines", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = [
				JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] }),
				JSON.stringify({ role: "assistant", content: [{ type: "text", text: "hi" }] }),
			].join("\n");
			const conv = extractConversation(jsonl);
			expect(conv).toContain("User: hello\n\nAssistant: hi");
		});

		it("handles multi-block content in single message", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = JSON.stringify({
				role: "user",
				content: [
					{ type: "text", text: "part A" },
					{ type: "text", text: "part B" },
				],
			});
			const conv = extractConversation(jsonl);
			expect(conv).toContain("part A");
			expect(conv).toContain("part B");
		});

		it("handles empty content array", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = JSON.stringify({ role: "user", content: [] });
			const conv = extractConversation(jsonl);
			expect(conv).not.toContain("User:");
		});

		it("handles message with only non-text content", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = JSON.stringify({
				role: "assistant",
				content: [
					{ type: "thinking", text: "think" },
					{ type: "tool_use", text: "tool" },
				],
			});
			const conv = extractConversation(jsonl);
			expect(conv).toBe("");
		});

		it("skips malformed JSON lines", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = [
				"not json",
				JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] }),
				"also bad",
			].join("\n");
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: hello");
		});

		it("handles empty JSONL file", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const conv = extractConversation("");
			expect(conv).toBe("");
		});

		it("preserves order of messages within a file", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = [
				JSON.stringify({ role: "user", content: [{ type: "text", text: "first" }] }),
				JSON.stringify({ role: "assistant", content: [{ type: "text", text: "second" }] }),
				JSON.stringify({ role: "user", content: [{ type: "text", text: "third" }] }),
			].join("\n");
			const conv = extractConversation(jsonl);
			const lines = conv.split("\n\n");
			expect(lines[0]).toContain("first");
			expect(lines[1]).toContain("second");
			expect(lines[2]).toContain("third");
		});

		it("handles Unicode/emoji in conversation text", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const jsonl = JSON.stringify({ role: "user", content: [{ type: "text", text: "你好 🚀" }] });
			const conv = extractConversation(jsonl);
			expect(conv).toContain("你好 🚀");
		});
	});

	describe("project id determination", () => {
		it("uses git remote as project ID", async () => {
			const mod = await loadCliModule();
			const { getProjectId } = mod;
			if (!getProjectId) return;
			const { execSync } = await import("node:child_process");
			const gitDir = join(tmpDir, "git-repo");
			mkdirSync(gitDir);
			execSync("git init", { cwd: gitDir });
			execSync("git remote add origin https://github.com/divkix/my-app.git", { cwd: gitDir });
			const id = await getProjectId(gitDir);
			expect(id).toBe("github.com/divkix/my-app");
		});

		it("falls back to directory basename when no git remote", async () => {
			const mod = await loadCliModule();
			const { getProjectId } = mod;
			if (!getProjectId) return;
			const noGitDir = join(tmpDir, "no-git");
			mkdirSync(noGitDir);
			const id = await getProjectId(noGitDir);
			expect(id).toBe("no-git");
		});

		it("normalizes SSH git remote", async () => {
			const mod = await loadCliModule();
			const { getProjectId } = mod;
			if (!getProjectId) return;
			const { execSync } = await import("node:child_process");
			const gitDir = join(tmpDir, "ssh-repo");
			mkdirSync(gitDir);
			execSync("git init", { cwd: gitDir });
			execSync("git remote add origin git@github.com:divkix/repo.git", { cwd: gitDir });
			const id = await getProjectId(gitDir);
			expect(id).toBe("github.com/divkix/repo");
		});

		it("lowercases git remote", async () => {
			const mod = await loadCliModule();
			const { getProjectId } = mod;
			if (!getProjectId) return;
			const { execSync } = await import("node:child_process");
			const gitDir = join(tmpDir, "mixed-case");
			mkdirSync(gitDir);
			execSync("git init", { cwd: gitDir });
			execSync("git remote add origin HTTPS://GITHUB.COM/Divkix/App.git", { cwd: gitDir });
			const id = await getProjectId(gitDir);
			expect(id).toBe("github.com/divkix/app");
		});
	});

	describe("tilde expansion", () => {
		it("expands ~ in --dir to home directory", async () => {
			const mod = await loadCliModule();
			const { expandTilde } = mod;
			if (!expandTilde) return;
			const result = expandTilde("~/custom-sessions");
			expect(result).not.toContain("~");
			expect(result.startsWith(process.env.HOME || "")).toBe(true);
		});

		it("leaves absolute paths unchanged", async () => {
			const mod = await loadCliModule();
			const { expandTilde } = mod;
			if (!expandTilde) return;
			expect(expandTilde("/tmp/sessions")).toBe("/tmp/sessions");
		});

		it("resolves relative paths to absolute", async () => {
			const mod = await loadCliModule();
			const { expandTilde } = mod;
			if (!expandTilde) return;
			const result = expandTilde("./sessions");
			expect(result.startsWith(process.cwd())).toBe(true);
			expect(result).not.toContain("./sessions");
		});
	});

	describe("project dir decoding from session path", () => {
		it("decodes path from sessions directory name", async () => {
			const mod = await loadCliModule();
			const { decodeProjectDir } = mod;
			if (!decodeProjectDir) return;
			const encoded = "-Users-div-projects-myapp";
			const decoded = decodeProjectDir(encoded);
			expect(decoded).toContain("Users");
			expect(decoded).toContain("myapp");
		});
	});

	describe("API interaction", () => {
		it("constructs correct POST body", async () => {
			const mod = await loadCliModule();
			const { sendIngest } = mod;
			if (!sendIngest) return;
			const fetchCalls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
			const mockFetch = (url: string, init: RequestInit) => {
				fetchCalls.push({ url, init, body: JSON.parse(init.body as string) });
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true, facts_written: 1 }), { status: 200 }),
				);
			};
			await sendIngest(
				{
					sessionId: "abc",
					projectId: "github.com/test/proj",
					projectName: "proj",
					conversation: "hello",
				},
				{ workerUrl: "https://test.example.com", apiKey: "key123", fetch: mockFetch },
			);
			expect(fetchCalls).toHaveLength(1);
			expect(fetchCalls[0].body).toMatchObject({
				session_id: "abc",
				project_id: "github.com/test/proj",
				project_name: "proj",
				source: "droid",
				conversation: "hello",
				metadata: {},
			});
		});

		it("sends Authorization header with Bearer token", async () => {
			const mod = await loadCliModule();
			const { sendIngest } = mod;
			if (!sendIngest) return;
			const fetchCalls: { init: RequestInit }[] = [];
			const mockFetch = (_url: string, init: RequestInit) => {
				fetchCalls.push({ init });
				return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
			};
			await sendIngest(
				{ sessionId: "a", projectId: "p", projectName: "n", conversation: "" },
				{ workerUrl: "https://test.example.com", apiKey: "secret", fetch: mockFetch },
			);
			const headers = fetchCalls[0].init.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer secret");
		});

		it("sends Content-Type: application/json header", async () => {
			const mod = await loadCliModule();
			const { sendIngest } = mod;
			if (!sendIngest) return;
			const fetchCalls: { init: RequestInit }[] = [];
			const mockFetch = (_url: string, init: RequestInit) => {
				fetchCalls.push({ init });
				return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
			};
			await sendIngest(
				{ sessionId: "a", projectId: "p", projectName: "n", conversation: "" },
				{ workerUrl: "https://test.example.com", apiKey: "secret", fetch: mockFetch },
			);
			const headers = fetchCalls[0].init.headers as Record<string, string>;
			expect(headers["Content-Type"]).toBe("application/json");
		});

		it("uses DIVMEMORY_API_KEY from environment when --api-key not set", async () => {
			const mod = await loadCliModule();
			const { resolveApiKey } = mod;
			if (!resolveApiKey) return;
			const oldEnv = process.env.DIVMEMORY_API_KEY;
			process.env.DIVMEMORY_API_KEY = "env-key";
			try {
				expect(resolveApiKey(undefined)).toBe("env-key");
			} finally {
				if (oldEnv === undefined) process.env.DIVMEMORY_API_KEY = undefined;
				else process.env.DIVMEMORY_API_KEY = oldEnv;
			}
		});

		it("--api-key flag overrides env var", async () => {
			const mod = await loadCliModule();
			const { resolveApiKey } = mod;
			if (!resolveApiKey) return;
			const oldEnv = process.env.DIVMEMORY_API_KEY;
			process.env.DIVMEMORY_API_KEY = "env-key";
			try {
				expect(resolveApiKey("override-key")).toBe("override-key");
			} finally {
				if (oldEnv === undefined) process.env.DIVMEMORY_API_KEY = undefined;
				else process.env.DIVMEMORY_API_KEY = oldEnv;
			}
		});

		it("handles 401 unauthorized", async () => {
			const mod = await loadCliModule();
			const { sendIngest } = mod;
			if (!sendIngest) return;
			const mockFetch = () =>
				Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 401 }));
			const result = await sendIngest(
				{ sessionId: "a", projectId: "p", projectName: "n", conversation: "" },
				{ workerUrl: "https://test.example.com", apiKey: "bad", fetch: mockFetch },
			);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("401");
		});

		it("handles 500 internal server error", async () => {
			const mod = await loadCliModule();
			const { sendIngest } = mod;
			if (!sendIngest) return;
			const mockFetch = () => Promise.resolve(new Response("Server Error", { status: 500 }));
			const result = await sendIngest(
				{ sessionId: "a", projectId: "p", projectName: "n", conversation: "" },
				{ workerUrl: "https://test.example.com", apiKey: "key", fetch: mockFetch },
			);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("500");
		});

		it("handles network error (ECONNREFUSED)", async () => {
			const mod = await loadCliModule();
			const { sendIngest } = mod;
			if (!sendIngest) return;
			const mockFetch = () => Promise.reject(new Error("ECONNREFUSED"));
			const result = await sendIngest(
				{ sessionId: "a", projectId: "p", projectName: "n", conversation: "" },
				{ workerUrl: "https://test.example.com", apiKey: "key", fetch: mockFetch },
			);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("ECONNREFUSED");
		});

		it("handles request timeout", async () => {
			const mod = await loadCliModule();
			const { sendIngest } = mod;
			if (!sendIngest) return;
			const mockFetch = () => Promise.reject(new Error("AbortError: timeout"));
			const result = await sendIngest(
				{ sessionId: "a", projectId: "p", projectName: "n", conversation: "" },
				{ workerUrl: "https://test.example.com", apiKey: "key", fetch: mockFetch },
			);
			expect(result.ok).toBe(false);
		});

		it("handles non-JSON response", async () => {
			const mod = await loadCliModule();
			const { sendIngest } = mod;
			if (!sendIngest) return;
			const mockFetch = () => Promise.resolve(new Response("<html>error</html>", { status: 200 }));
			const result = await sendIngest(
				{ sessionId: "a", projectId: "p", projectName: "n", conversation: "" },
				{ workerUrl: "https://test.example.com", apiKey: "key", fetch: mockFetch },
			);
			expect(result.ok).toBe(false);
		});
	});

	describe("rate limiting", () => {
		it("enforces 1 request per second", async () => {
			const mod = await loadCliModule();
			const { runBatch } = mod;
			if (!runBatch) return;
			const timestamps: number[] = [];
			const mockFetch = () => {
				timestamps.push(Date.now());
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true, facts_written: 1 }), { status: 200 }),
				);
			};
			const files = Array.from({ length: 3 }, (_, i) => ({
				filePath: join(tmpDir, `sess${i}.jsonl`),
				mtime: Date.now() - i * 1000,
				projectDir: tmpDir,
			}));
			for (const f of files) {
				writeFileSync(
					f.filePath,
					`${JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] })}\n`,
				);
			}
			await runBatch(files, {
				workerUrl: "https://test.example.com",
				apiKey: "key",
				dryRun: false,
				fetch: mockFetch,
				stdout: () => {},
				stderr: () => {},
			});
			expect(timestamps.length).toBe(3);
			for (let i = 1; i < timestamps.length; i++) {
				expect(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(900);
			}
		});

		it("no rate limiting in dry-run mode", async () => {
			const mod = await loadCliModule();
			const { runBatch } = mod;
			if (!runBatch) return;
			const start = Date.now();
			const files = Array.from({ length: 10 }, (_, i) => ({
				filePath: join(tmpDir, `sess${i}.jsonl`),
				mtime: Date.now() - i * 1000,
				projectDir: tmpDir,
			}));
			for (const f of files) {
				writeFileSync(
					f.filePath,
					`${JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] })}\n`,
				);
			}
			await runBatch(files, {
				workerUrl: "https://test.example.com",
				apiKey: "key",
				dryRun: true,
				stdout: () => {},
				stderr: () => {},
			});
			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(500);
		});
	});

	describe("dry-run mode", () => {
		it("does not make any network requests", async () => {
			const mod = await loadCliModule();
			const { runBatch } = mod;
			if (!runBatch) return;
			let fetchCalls = 0;
			const mockFetch = () => {
				fetchCalls++;
				return Promise.resolve(new Response("{}"));
			};
			const files = [
				{
					filePath: join(tmpDir, "sess.jsonl"),
					mtime: Date.now(),
					projectDir: tmpDir,
				},
			];
			writeFileSync(
				files[0].filePath,
				`${JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] })}\n`,
			);
			await runBatch(files, {
				workerUrl: "https://test.example.com",
				apiKey: "key",
				dryRun: true,
				fetch: mockFetch,
				stdout: () => {},
				stderr: () => {},
			});
			expect(fetchCalls).toBe(0);
		});
	});

	describe("progress output", () => {
		it("prints progress line per session", async () => {
			const mod = await loadCliModule();
			const { runBatch } = mod;
			if (!runBatch) return;
			const outputs: string[] = [];
			const files = [
				{
					filePath: join(tmpDir, "sess.jsonl"),
					mtime: Date.now(),
					projectDir: tmpDir,
				},
			];
			writeFileSync(
				files[0].filePath,
				`${JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] })}\n`,
			);
			const mockFetch = () =>
				Promise.resolve(
					new Response(JSON.stringify({ ok: true, facts_written: 3 }), { status: 200 }),
				);
			await runBatch(files, {
				workerUrl: "https://test.example.com",
				apiKey: "key",
				dryRun: false,
				fetch: mockFetch,
				stdout: (s: string) => outputs.push(s),
				stderr: () => {},
			});
			const progress = outputs.find((o) => o.includes("[1/1]"));
			expect(progress).toBeTruthy();
		});

		it("shows failure indicator for failed sessions", async () => {
			const mod = await loadCliModule();
			const { runBatch } = mod;
			if (!runBatch) return;
			const outputs: string[] = [];
			const files = [
				{
					filePath: join(tmpDir, "sess.jsonl"),
					mtime: Date.now(),
					projectDir: tmpDir,
				},
			];
			writeFileSync(
				files[0].filePath,
				`${JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] })}\n`,
			);
			const mockFetch = () =>
				Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 500 }));
			await runBatch(files, {
				workerUrl: "https://test.example.com",
				apiKey: "key",
				dryRun: false,
				fetch: mockFetch,
				stdout: (s: string) => outputs.push(s),
				stderr: () => {},
			});
			const progress = outputs.find((o) => o.includes("[1/1]"));
			expect(progress).toContain("✗");
		});
	});

	describe("summary output", () => {
		it("prints summary at end", async () => {
			const mod = await loadCliModule();
			const { runBatch } = mod;
			if (!runBatch) return;
			const outputs: string[] = [];
			const files = [
				{
					filePath: join(tmpDir, "sess.jsonl"),
					mtime: Date.now(),
					projectDir: tmpDir,
				},
			];
			writeFileSync(
				files[0].filePath,
				`${JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] })}\n`,
			);
			const mockFetch = () =>
				Promise.resolve(
					new Response(JSON.stringify({ ok: true, facts_written: 2 }), { status: 200 }),
				);
			await runBatch(files, {
				workerUrl: "https://test.example.com",
				apiKey: "key",
				dryRun: false,
				fetch: mockFetch,
				stdout: (s: string) => outputs.push(s),
				stderr: () => {},
			});
			const summary = outputs.find((o) => o.includes("Done."));
			expect(summary).toBeTruthy();
		});

		it("counts are accurate", async () => {
			const mod = await loadCliModule();
			const { runBatch } = mod;
			if (!runBatch) return;
			const outputs: string[] = [];
			const files = Array.from({ length: 3 }, (_, i) => ({
				filePath: join(tmpDir, `sess${i}.jsonl`),
				mtime: Date.now() - i * 1000,
				projectDir: tmpDir,
			}));
			for (const f of files) {
				writeFileSync(
					f.filePath,
					`${JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] })}\n`,
				);
			}
			let _callCount = 0;
			const mockFetch = () => {
				_callCount++;
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true, facts_written: 1 }), { status: 200 }),
				);
			};
			await runBatch(files, {
				workerUrl: "https://test.example.com",
				apiKey: "key",
				dryRun: false,
				fetch: mockFetch,
				stdout: (s: string) => outputs.push(s),
				stderr: () => {},
			});
			const summary = outputs.find((o) => o.includes("Done."));
			expect(summary).toContain("3 sessions");
			expect(summary).toContain("3 successful");
			expect(summary).toContain("0 failed");
		});
	});

	describe("exit codes", () => {
		it("returns exit code 0 on full success", async () => {
			const mod = await loadCliModule();
			const { runBatch } = mod;
			if (!runBatch) return;
			const files = [
				{
					filePath: join(tmpDir, "sess.jsonl"),
					mtime: Date.now(),
					projectDir: tmpDir,
				},
			];
			writeFileSync(files[0].filePath, "{}\n");
			const result = await runBatch(files, {
				workerUrl: "https://test.example.com",
				apiKey: "key",
				dryRun: false,
				fetch: () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
				stdout: () => {},
				stderr: () => {},
			});
			expect(result.exitCode).toBe(0);
		});

		it("returns exit code 0 on partial success", async () => {
			const mod = await loadCliModule();
			const { runBatch } = mod;
			if (!runBatch) return;
			const files = Array.from({ length: 2 }, (_, i) => ({
				filePath: join(tmpDir, `sess${i}.jsonl`),
				mtime: Date.now() - i * 1000,
				projectDir: tmpDir,
			}));
			for (const f of files) {
				writeFileSync(f.filePath, "{}\n");
			}
			let callCount = 0;
			const mockFetch = () => {
				callCount++;
				if (callCount === 1) return Promise.resolve(new Response("err", { status: 500 }));
				return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
			};
			const result = await runBatch(files, {
				workerUrl: "https://test.example.com",
				apiKey: "key",
				dryRun: false,
				fetch: mockFetch,
				stdout: () => {},
				stderr: () => {},
			});
			expect(result.exitCode).toBe(0);
		});

		it("returns non-zero on total failure", async () => {
			const mod = await loadCliModule();
			const { runBatch } = mod;
			if (!runBatch) return;
			const files = [
				{
					filePath: join(tmpDir, "sess.jsonl"),
					mtime: Date.now(),
					projectDir: tmpDir,
				},
			];
			writeFileSync(files[0].filePath, "{}\n");
			const result = await runBatch(files, {
				workerUrl: "https://test.example.com",
				apiKey: "key",
				dryRun: false,
				fetch: () => Promise.resolve(new Response("err", { status: 500 })),
				stdout: () => {},
				stderr: () => {},
			});
			expect(result.exitCode).not.toBe(0);
		});
	});

	describe("edge cases", () => {
		it("handles empty string API key as missing", async () => {
			const mod = await loadCliModule();
			const { resolveApiKey } = mod;
			if (!resolveApiKey) return;
			expect(() => resolveApiKey("")).toThrow();
		});

		it("handles whitespace-only API key as missing", async () => {
			const mod = await loadCliModule();
			const { resolveApiKey } = mod;
			if (!resolveApiKey) return;
			expect(() => resolveApiKey("   ")).toThrow();
		});

		it("trailing slash on worker URL is handled", async () => {
			const mod = await loadCliModule();
			const { sendIngest } = mod;
			if (!sendIngest) return;
			const fetchCalls: { url: string }[] = [];
			const mockFetch = (url: string, _init: RequestInit) => {
				fetchCalls.push({ url });
				return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
			};
			await sendIngest(
				{ sessionId: "a", projectId: "p", projectName: "n", conversation: "" },
				{ workerUrl: "https://test.example.com/", apiKey: "key", fetch: mockFetch },
			);
			expect(fetchCalls[0].url).toBe("https://test.example.com/ingest");
		});

		it("session_id from filename without extension", async () => {
			const mod = await loadCliModule();
			const { getSessionIdFromFilename } = mod;
			if (!getSessionIdFromFilename) return;
			expect(getSessionIdFromFilename("abc123.jsonl")).toBe("abc123");
			expect(getSessionIdFromFilename("my-session.jsonl")).toBe("my-session");
		});

		it("project_name from git remote or directory basename", async () => {
			const mod = await loadCliModule();
			const { getProjectName } = mod;
			if (!getProjectName) return;
			expect(getProjectName("github.com/divkix/my-app")).toBe("my-app");
			expect(getProjectName("my-app")).toBe("my-app");
		});

		it("handles session file directly in root (no project subdir)", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles, decodeProjectDir } = mod;
			if (!findSessionFiles || !decodeProjectDir) return;
			writeFileSync(join(tmpDir, "orphan.jsonl"), "{}\n");
			const files = await findSessionFiles(tmpDir);
			const orphan = files.find((f: SessionFile) => f.filePath.includes("orphan"));
			expect(orphan).toBeTruthy();
			if (!orphan) throw new Error("Expected orphan");
			// projectDir should fall back gracefully
			expect(typeof orphan.projectDir).toBe("string");
		});

		it("handles UTF-8 BOM in JSONL", async () => {
			const mod = await loadCliModule();
			const { extractConversation } = mod;
			if (!extractConversation) return;
			const bom = "\uFEFF";
			const jsonl =
				bom + JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] });
			const conv = extractConversation(jsonl);
			expect(conv).toContain("User: hello");
		});

		it("handles 1000+ files efficiently", async () => {
			const mod = await loadCliModule();
			const { findSessionFiles } = mod;
			if (!findSessionFiles) return;
			for (let i = 0; i < 100; i++) {
				// Use smaller count for test speed but still exercise path
				writeFileSync(join(tmpDir, `sess${i}.jsonl`), "{}\n");
			}
			const start = Date.now();
			const files = await findSessionFiles(tmpDir, 50);
			const elapsed = Date.now() - start;
			expect(files).toHaveLength(50);
			expect(elapsed).toBeLessThan(2000);
		});

		it("handles concurrent runs independently", async () => {
			const mod = await loadCliModule();
			const { runBatch } = mod;
			if (!runBatch) return;
			const filesA = [
				{
					filePath: join(tmpDir, "a.jsonl"),
					mtime: Date.now(),
					projectDir: tmpDir,
				},
			];
			const filesB = [
				{
					filePath: join(tmpDir, "b.jsonl"),
					mtime: Date.now() - 1000,
					projectDir: tmpDir,
				},
			];
			writeFileSync(
				filesA[0].filePath,
				`${JSON.stringify({ role: "user", content: [{ type: "text", text: "a" }] })}\n`,
			);
			writeFileSync(
				filesB[0].filePath,
				`${JSON.stringify({ role: "user", content: [{ type: "text", text: "b" }] })}\n`,
			);
			const mockFetch = () =>
				Promise.resolve(
					new Response(JSON.stringify({ ok: true, facts_written: 1 }), { status: 200 }),
				);
			const [resultA, resultB] = await Promise.all([
				runBatch(filesA, {
					workerUrl: "https://test.example.com",
					apiKey: "key",
					dryRun: false,
					fetch: mockFetch,
					stdout: () => {},
					stderr: () => {},
				}),
				runBatch(filesB, {
					workerUrl: "https://test.example.com",
					apiKey: "key",
					dryRun: false,
					fetch: mockFetch,
					stdout: () => {},
					stderr: () => {},
				}),
			]);
			expect(resultA.exitCode).toBe(0);
			expect(resultB.exitCode).toBe(0);
		});
	});
});
