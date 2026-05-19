import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractConversation, getProjectId, processSessionEnd } from "../scripts/session-end.mjs";

describe("session-end hook", () => {
	let tmpDir: string;
	let originalEnv: Record<string, string | undefined>;
	let capturedStderr: string[];
	let capturedStdout: string[];
	let fetchCalls: Array<{ url: string; init: RequestInit; body: unknown }>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "session-end-test-"));
		originalEnv = {
			DIVMEMORY_API_KEY: process.env.DIVMEMORY_API_KEY,
			DIVMEMORY_WORKER_URL: process.env.DIVMEMORY_WORKER_URL,
		};
		capturedStderr = [];
		capturedStdout = [];
		fetchCalls = [];
	});

	afterEach(() => {
		// Restore env
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
			return new Response(JSON.stringify({ ok: true, facts_written: 3 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
	}

	function makeStdin(overrides: Record<string, unknown> = {}, event: string = "SessionEnd") {
		return JSON.stringify({
			session_id: "test-session-1",
			cwd: tmpDir,
			transcript_path: join(tmpDir, "test.jsonl"),
			hook_event_name: event,
			reason: "normal",
			...overrides,
		});
	}

	// ============================================================
	// VAL-PLUGIN-001: Receives and parses Droid SessionEnd hook JSON via stdin
	// VAL-PLUGIN-034: Handles malformed JSON from stdin
	// VAL-PLUGIN-035: Handles empty stdin
	// VAL-PLUGIN-098: Missing reason field
	// VAL-PLUGIN-099: hook_event_name mismatch
	// VAL-PLUGIN-100: Unknown fields
	// VAL-PLUGIN-032: Missing cwd
	// VAL-PLUGIN-033: Missing session_id
	// ============================================================
	describe("stdin parsing", () => {
		it("parses valid SessionEnd JSON from stdin (VAL-PLUGIN-001)", async () => {
			const stdin = makeStdin();
			const jsonl = makeJsonl([
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi" },
			]);
			writeFileSync(join(tmpDir, "test.jsonl"), jsonl, "utf-8");
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			const result = await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(fetchCalls).toHaveLength(1);
			expect(fetchCalls[0].body).toMatchObject({
				session_id: "test-session-1",
			});
		});

		it("ignores unknown extra fields in stdin (VAL-PLUGIN-100)", async () => {
			const stdin = makeStdin({ future_field: "value" });
			const jsonl = makeJsonl([{ role: "user", content: "hello" }]);
			writeFileSync(join(tmpDir, "test.jsonl"), jsonl, "utf-8");
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			const result = await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(fetchCalls[0].body).toHaveProperty("session_id", "test-session-1");
		});

		it("works when reason field is missing (VAL-PLUGIN-098)", async () => {
			const stdin = JSON.stringify({
				session_id: "test-session-1",
				cwd: tmpDir,
				transcript_path: join(tmpDir, "test.jsonl"),
				hook_event_name: "SessionEnd",
			});
			const jsonl = makeJsonl([{ role: "user", content: "hello" }]);
			writeFileSync(join(tmpDir, "test.jsonl"), jsonl, "utf-8");
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			const result = await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(fetchCalls).toHaveLength(1);
		});

		it("handles missing session_id by logging and exiting 0 (VAL-PLUGIN-033)", async () => {
			const stdin = JSON.stringify({
				cwd: tmpDir,
				transcript_path: join(tmpDir, "test.jsonl"),
				hook_event_name: "SessionEnd",
			});
			const fetchFn = mockFetch();
			const result = await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("session_id");
			expect(fetchCalls).toHaveLength(0);
		});

		it("handles malformed stdin JSON and exits 0 (VAL-PLUGIN-034)", async () => {
			const fetchFn = mockFetch();
			const result = await processSessionEnd("not json", {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("Malformed JSON");
		});

		it("handles empty stdin by exiting 0 (VAL-PLUGIN-035)", async () => {
			const fetchFn = mockFetch();
			const result = await processSessionEnd("", {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("No stdin data");
		});

		it("detects wrong hook_event_name and warns (VAL-PLUGIN-099)", async () => {
			const stdin = makeStdin({}, "SessionStart");
			const fetchFn = mockFetch();
			const result = await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("SessionStart");
			expect(capturedStderr.join("")).toContain("SessionEnd");
		});
	});

	// ============================================================
	// VAL-PLUGIN-002: Extracts project ID from git remote
	// VAL-PLUGIN-003: Falls back to basename(cwd)
	// VAL-PLUGIN-004: Handles git remote URL in various formats
	// VAL-PLUGIN-036: Git command not found
	// VAL-PLUGIN-104: Case normalization
	// ============================================================
	describe("project ID detection", () => {
		it("extracts project_id from git remote origin URL (VAL-PLUGIN-002)", async () => {
			// Create a git repo with origin
			const gitDir = join(tmpDir, "git-repo");
			const { execSync } = await import("node:child_process");
			execSync(
				`mkdir -p ${gitDir} && cd ${gitDir} && git init && git remote add origin https://github.com/divkix/my-app.git`,
			);
			const id = await getProjectId(gitDir);
			expect(id).toBe("github.com/divkix/my-app");
		});

		it("falls back to basename(cwd) when no git remote (VAL-PLUGIN-003)", async () => {
			const noGitDir = join(tmpDir, "no-git");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(noGitDir, { recursive: true });
			const id = await getProjectId(noGitDir);
			expect(id).toBe("no-git");
		});

		it("normalizes HTTPS git remote URL (VAL-PLUGIN-004)", async () => {
			const gitDir = join(tmpDir, "https-repo");
			const { execSync } = await import("node:child_process");
			execSync(
				`mkdir -p ${gitDir} && cd ${gitDir} && git init && git remote add origin https://github.com/divkix/my-app.git`,
			);
			const id = await getProjectId(gitDir);
			expect(id).toBe("github.com/divkix/my-app");
		});

		it("normalizes SSH git@ remote URL (VAL-PLUGIN-004)", async () => {
			const gitDir = join(tmpDir, "ssh-repo");
			const { execSync } = await import("node:child_process");
			execSync(
				`mkdir -p ${gitDir} && cd ${gitDir} && git init && git remote add origin git@github.com:divkix/my-app.git`,
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

		it("normalizes mixed-case git remote casing (VAL-PLUGIN-104)", async () => {
			const gitDir = join(tmpDir, "mixed-case");
			const { execSync } = await import("node:child_process");
			execSync(
				`mkdir -p ${gitDir} && cd ${gitDir} && git init && git remote add origin https://GITHUB.COM/Divkix/My-App.git`,
			);
			const id = await getProjectId(gitDir);
			// Should be consistently cased (all lower)
			expect(id).toBe(id.toLowerCase());
			expect(id).toContain("github.com");
		});
	});

	// ============================================================
	// VAL-PLUGIN-005: Reads JSONL transcript from transcript_path
	// VAL-PLUGIN-006: Parses JSONL line by line, skips non-message types
	// VAL-PLUGIN-007,008: Keeps user and assistant text content
	// VAL-PLUGIN-009,010,011,012: Strips thinking, tool_use, system-reminder, system-notification
	// VAL-PLUGIN-039: Strips tool_result blocks from user messages
	// VAL-PLUGIN-013,014: User:/Assistant: prefixes, separated by \n\n
	// VAL-PLUGIN-040: Content as plain strings
	// VAL-PLUGIN-094: Empty content array
	// VAL-PLUGIN-095: Mixed content blocks
	// VAL-PLUGIN-096: Empty text field
	// VAL-PLUGIN-097: Plain string empty content
	// VAL-PLUGIN-103: Missing content field
	// ============================================================
	describe("conversation extraction", () => {
		it("keeps user and assistant text blocks (VAL-PLUGIN-007/008)", () => {
			const jsonl = makeJsonl([
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi there" },
			]);
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: hello\n\nAssistant: hi there");
		});

		it("strips thinking blocks (VAL-PLUGIN-009)", () => {
			const jsonl = makeJsonl([
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "..." },
						{ type: "text", text: "Here's the fix:" },
					],
				},
			]);
			const conv = extractConversation(jsonl);
			expect(conv).toContain("Assistant: Here's the fix:");
			expect(conv).not.toContain("thinking");
		});

		it("strips tool_use blocks (VAL-PLUGIN-010)", () => {
			const jsonl = makeJsonl([
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Let me check" },
						{ type: "tool_use", tool_use: { name: "read" } },
					],
				},
			]);
			const conv = extractConversation(jsonl);
			expect(conv).toContain("Assistant: Let me check");
			expect(conv).not.toContain("tool_use");
			expect(conv).not.toContain("read");
		});

		it("strips system-reminder at top level (VAL-PLUGIN-011)", () => {
			const jsonl = makeJsonl([
				{ type: "system-reminder", content: "You have skills..." },
				{ role: "user", content: "hello" },
			]);
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: hello");
			expect(conv).not.toContain("skills");
		});

		it("strips system-notification at top level (VAL-PLUGIN-012)", () => {
			const jsonl = makeJsonl([
				{ type: "system-notification", content: "Something happened" },
				{ role: "user", content: "hello" },
			]);
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: hello");
		});

		it("strips tool_result blocks from user messages (VAL-PLUGIN-039)", () => {
			const jsonl = makeJsonl([
				{
					role: "user",
					content: [
						{ type: "text", text: "Run this" },
						{ type: "tool_result", content: "42" },
					],
				},
			]);
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: Run this");
			expect(conv).not.toContain("42");
		});

		it("handles content as plain strings (VAL-PLUGIN-040)", () => {
			const jsonl = makeJsonl([{ role: "user", content: "plain string" }]);
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: plain string");
		});

		it("handles empty content array — skips message (VAL-PLUGIN-094)", () => {
			const jsonl = makeJsonl([
				{ role: "user", content: [] },
				{ role: "user", content: "real message" },
			]);
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: real message");
		});

		it("handles mixed content blocks — keeps text in order, strips rest (VAL-PLUGIN-095)", () => {
			const jsonl = makeJsonl([
				{
					role: "assistant",
					content: [
						{ type: "text", text: "First:" },
						{ type: "thinking", thinking: "..." },
						{ type: "text", text: "Second:" },
					],
				},
			]);
			const conv = extractConversation(jsonl);
			// Adjacent text blocks in same message are joined with newline
			expect(conv).toBe("Assistant: First:\nSecond:");
			expect(conv).not.toContain("thinking");
		});

		it("handles empty text field in content block (VAL-PLUGIN-096)", () => {
			const jsonl = makeJsonl([
				{
					role: "user",
					content: [
						{ type: "text", text: "" },
						{ type: "text", text: "real" },
					],
				},
			]);
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: real");
		});

		it("handles plain string that is empty (VAL-PLUGIN-097)", () => {
			const jsonl = makeJsonl([
				{ role: "user", content: "" },
				{ role: "user", content: "real" },
			]);
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: real");
		});

		it("handles missing content field (VAL-PLUGIN-103)", () => {
			const jsonl = makeJsonl([{ role: "user" }, { role: "user", content: "real" }]);
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: real");
		});

		it("skips invalid JSONL lines and continues (VAL-PLUGIN-025)", () => {
			const jsonl = [
				"not json",
				JSON.stringify({ role: "user", content: "hello" }),
				`{invalid`,
				JSON.stringify({ role: "assistant", content: "hi" }),
			].join("\n");
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: hello\n\nAssistant: hi");
		});

		it("produces User: and Assistant: prefixes with double newlines (VAL-PLUGIN-013/014)", () => {
			const jsonl = makeJsonl([
				{ role: "user", content: "A" },
				{ role: "assistant", content: "B" },
				{ role: "user", content: "C" },
			]);
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: A\n\nAssistant: B\n\nUser: C");
		});
	});

	// ============================================================
	// VAL-PLUGIN-015–021: POST behavior, auth, URLs
	// VAL-PLUGIN-022: stderr logging
	// VAL-PLUGIN-026: Missing API key
	// VAL-PLUGIN-027: Network failure
	// VAL-PLUGIN-028: Worker non-200
	// VAL-PLUGIN-029: Worker error JSON
	// VAL-PLUGIN-030: Empty conversation
	// VAL-PLUGIN-037: 90s timeout
	// VAL-PLUGIN-038: HTTP timeout
	// VAL-PLUGIN-101: Worker 200 with empty body
	// ============================================================
	describe("POST and API interaction", () => {
		it("POSTs correct body shape with all required fields (VAL-PLUGIN-015)", async () => {
			const stdin = makeStdin();
			const jsonl = makeJsonl([{ role: "user", content: "hello" }]);
			writeFileSync(join(tmpDir, "test.jsonl"), jsonl, "utf-8");
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			const result = await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(fetchCalls).toHaveLength(1);
			const body = fetchCalls[0].body as Record<string, unknown>;
			expect(body).toHaveProperty("session_id", "test-session-1");
			expect(body).toHaveProperty("project_id");
			expect(body).toHaveProperty("project_name");
			expect(body).toHaveProperty("source");
			expect(body).toHaveProperty("conversation");
			expect(body).toHaveProperty("metadata");
		});

		it("sets source to droid (VAL-PLUGIN-016)", async () => {
			const stdin = makeStdin();
			writeFileSync(
				join(tmpDir, "test.jsonl"),
				makeJsonl([{ role: "user", content: "hi" }]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect((fetchCalls[0].body as Record<string, string>).source).toBe("droid");
		});

		it("sends empty metadata {} (VAL-PLUGIN-017)", async () => {
			const stdin = makeStdin();
			writeFileSync(
				join(tmpDir, "test.jsonl"),
				makeJsonl([{ role: "user", content: "hi" }]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect((fetchCalls[0].body as Record<string, unknown>).metadata).toEqual({});
		});

		it("derives project_name from project_id for git remote (VAL-PLUGIN-018)", async () => {
			const gitDir = join(tmpDir, "git-repo");
			const { execSync } = await import("node:child_process");
			execSync(
				`mkdir -p ${gitDir} && cd ${gitDir} && git init && git remote add origin https://github.com/divkix/my-app.git`,
			);
			const stdin = makeStdin({ cwd: gitDir, transcript_path: join(gitDir, "test.jsonl") });
			writeFileSync(
				join(gitDir, "test.jsonl"),
				makeJsonl([{ role: "user", content: "hi" }]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			const body = fetchCalls[0].body as Record<string, string>;
			expect(body.project_id).toBe("github.com/divkix/my-app");
			expect(body.project_name).toBe("my-app");
		});

		it("derives project_name from cwd basename when no git remote (VAL-PLUGIN-018)", async () => {
			const noGitDir = join(tmpDir, "fallback-dir");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(noGitDir, { recursive: true });
			const stdin = makeStdin({ cwd: noGitDir, transcript_path: join(noGitDir, "test.jsonl") });
			writeFileSync(
				join(noGitDir, "test.jsonl"),
				makeJsonl([{ role: "user", content: "hi" }]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			const body = fetchCalls[0].body as Record<string, string>;
			expect(body.project_id).toBe("fallback-dir");
			expect(body.project_name).toBe("fallback-dir");
		});

		it("reads DIVMEMORY_API_KEY from env for Bearer auth (VAL-PLUGIN-019)", async () => {
			const stdin = makeStdin();
			writeFileSync(
				join(tmpDir, "test.jsonl"),
				makeJsonl([{ role: "user", content: "hi" }]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "my-secret-key";
			const fetchFn = mockFetch();
			await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			const headers = fetchCalls[0].init.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer my-secret-key");
		});

		it("respects DIVMEMORY_WORKER_URL env var (VAL-PLUGIN-020)", async () => {
			const stdin = makeStdin();
			writeFileSync(
				join(tmpDir, "test.jsonl"),
				makeJsonl([{ role: "user", content: "hi" }]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "test-key";
			process.env.DIVMEMORY_WORKER_URL = "https://custom.example.com";
			const fetchFn = mockFetch();
			await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(fetchCalls[0].url).toBe("https://custom.example.com/ingest");
		});

		it("uses default worker URL when DIVMEMORY_WORKER_URL unset (VAL-PLUGIN-021)", async () => {
			const stdin = makeStdin();
			writeFileSync(
				join(tmpDir, "test.jsonl"),
				makeJsonl([{ role: "user", content: "hi" }]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "test-key";
			delete process.env.DIVMEMORY_WORKER_URL;
			const fetchFn = mockFetch();
			await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(fetchCalls[0].url).toBe("https://divmemory.divkix.workers.dev/ingest");
		});

		it("logs errors to stderr, never stdout (VAL-PLUGIN-022)", async () => {
			const stdin = makeStdin();
			writeFileSync(
				join(tmpDir, "test.jsonl"),
				makeJsonl([{ role: "user", content: "hi" }]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			// On success, may log to stderr
			expect(capturedStdout.join("")).toBe("");
		});

		it("exits 0 even when transcript_path is missing (VAL-PLUGIN-024)", async () => {
			const stdin = makeStdin({ transcript_path: join(tmpDir, "nonexistent.jsonl") });
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			const result = await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("Failed to read transcript");
		});

		it("exits 0 when DIVMEMORY_API_KEY is missing (VAL-PLUGIN-026)", async () => {
			const stdin = makeStdin();
			writeFileSync(
				join(tmpDir, "test.jsonl"),
				makeJsonl([{ role: "user", content: "hi" }]),
				"utf-8",
			);
			delete process.env.DIVMEMORY_API_KEY;
			const fetchFn = mockFetch();
			const result = await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("DIVMEMORY_API_KEY");
			expect(fetchCalls).toHaveLength(0);
		});

		it("exits 0 on network failure (VAL-PLUGIN-027)", async () => {
			const stdin = makeStdin();
			writeFileSync(
				join(tmpDir, "test.jsonl"),
				makeJsonl([{ role: "user", content: "hi" }]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = () => Promise.reject(new Error("ECONNREFUSED"));
			const result = await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("Network error");
		});

		it("exits 0 when Worker returns non-200 (VAL-PLUGIN-028)", async () => {
			const stdin = makeStdin();
			writeFileSync(
				join(tmpDir, "test.jsonl"),
				makeJsonl([{ role: "user", content: "hi" }]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch(() =>
				Promise.resolve(new Response("Internal Server Error", { status: 500 })),
			);
			const result = await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("500");
		});

		it("exits 0 when Worker returns 200 with empty body (VAL-PLUGIN-101)", async () => {
			const stdin = makeStdin();
			writeFileSync(
				join(tmpDir, "test.jsonl"),
				makeJsonl([{ role: "user", content: "hi" }]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
			const result = await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("Empty response");
		});

		it("handles empty conversation and still POSTs (VAL-PLUGIN-030)", async () => {
			const stdin = makeStdin();
			writeFileSync(
				join(tmpDir, "test.jsonl"),
				makeJsonl([
					{ type: "thinking", thinking: "..." },
					{ type: "system-reminder", content: "skills" },
				]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(fetchCalls).toHaveLength(1);
			expect((fetchCalls[0].body as Record<string, string>).conversation).toBe("");
		});
	});

	// ============================================================
	// Edge cases not in primary assertions block
	// ============================================================
	describe("edge cases", () => {
		it("handles Unicode and emoji in transcript path (VAL-PLUGIN-102)", async () => {
			const unicodeDir = join(tmpDir, "测试 🚀");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(unicodeDir, { recursive: true });
			const stdin = makeStdin({
				cwd: unicodeDir,
				transcript_path: join(unicodeDir, "转录.jsonl"),
			});
			writeFileSync(
				join(unicodeDir, "转录.jsonl"),
				makeJsonl([{ role: "user", content: "hello" }]),
				"utf-8",
			);
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			const result = await processSessionEnd(stdin, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect((fetchCalls[0].body as Record<string, string>).conversation).toBe("User: hello");
		});

		it("handles missing transcript_path quietly (VAL-PLUGIN-024)", async () => {
			const stdin = makeStdin({});
			delete (JSON.parse(stdin) as Record<string, unknown>).transcript_path;
			const stdinNoPath = JSON.stringify({
				...JSON.parse(makeStdin()),
				transcript_path: undefined,
			});
			process.env.DIVMEMORY_API_KEY = "test-key";
			const fetchFn = mockFetch();
			const result = await processSessionEnd(stdinNoPath, {
				fetch: fetchFn,
				stderr: (s: string) => capturedStderr.push(s),
				stdout: (s: string) => capturedStdout.push(s),
			});
			expect(result.exitCode).toBe(0);
			expect(capturedStderr.join("")).toContain("transcript_path");
		});

		it("handles very large transcript by processing line-by-line (VAL-PLUGIN-031)", async () => {
			// Generate a large JSONL with repeated messages
			const lines: string[] = [];
			for (let i = 0; i < 1000; i++) {
				lines.push(JSON.stringify({ role: "user", content: `message ${i}` }));
			}
			const largeJsonl = lines.join("\n");
			const start = performance.now();
			const conv = extractConversation(largeJsonl);
			const elapsed = performance.now() - start;
			expect(conv).toContain("User: message 0");
			expect(conv).toContain("message 999");
			expect(elapsed).toBeLessThan(5000); // Well under 90s
		});

		it("merges consecutive same-role messages with newline", () => {
			const jsonl = makeJsonl([
				{ role: "user", content: "line 1" },
				{ role: "user", content: "line 2" },
				{ role: "assistant", content: "reply" },
			]);
			const conv = extractConversation(jsonl);
			expect(conv).toBe("User: line 1\nline 2\n\nAssistant: reply");
		});
	});
});

function makeJsonl(lines: unknown[]): string {
	return lines.map((l) => JSON.stringify(l)).join("\n");
}
