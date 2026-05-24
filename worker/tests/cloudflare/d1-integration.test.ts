import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("D1 integration (Miniflare)", () => {
	it("applies migrations and exposes the memories table", async () => {
		const row = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'",
		).first<{ name: string }>();
		expect(row?.name).toBe("memories");
	});

	it("inserts a project, session, and memory with foreign keys", async () => {
		const now = new Date().toISOString();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO projects (id, name, session_count, created_at, last_seen) VALUES (?, ?, 1, ?, ?)",
			).bind("proj/cf-fk", "CF FK", now, now),
			env.DB.prepare(
				"INSERT INTO sessions (id, project_id, source, raw_text, consolidated, created_at) VALUES (?, ?, 'test', 'User: hi', 0, ?)",
			).bind("sess-cf-fk", "proj/cf-fk", now),
			env.DB.prepare(
				"INSERT INTO memories (id, project_id, source_session, topic, content, confidence, status, created_at, updated_at) VALUES (?, ?, ?, 'topic', 'content', 0.9, 'active', ?, ?)",
			).bind("mem-cf-fk", "proj/cf-fk", "sess-cf-fk", now, now),
		]);

		const memory = await env.DB.prepare("SELECT id, project_id FROM memories WHERE id = ?")
			.bind("mem-cf-fk")
			.first<{ id: string; project_id: string }>();
		expect(memory?.project_id).toBe("proj/cf-fk");
	});

	it("bulk-inserts many memories within D1 batch limits", async () => {
		const now = new Date().toISOString();
		const projectId = "proj/cf-bulk";
		const sessionId = "sess-cf-bulk";

		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO projects (id, name, session_count, created_at, last_seen) VALUES (?, ?, 0, ?, ?)",
			).bind(projectId, "Bulk", now, now),
			env.DB.prepare(
				"INSERT INTO sessions (id, project_id, source, raw_text, consolidated, created_at) VALUES (?, ?, 'test', '', 0, ?)",
			).bind(sessionId, projectId, now),
		]);

		const statements = Array.from({ length: 50 }, (_, i) =>
			env.DB.prepare(
				"INSERT INTO memories (id, project_id, source_session, topic, content, confidence, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?)",
			).bind(`mem-cf-bulk-${i}`, projectId, sessionId, `t${i}`, `body ${i}`, now, now),
		);

		await env.DB.batch(statements);

		const count = await env.DB.prepare("SELECT COUNT(*) as c FROM memories WHERE project_id = ?")
			.bind(projectId)
			.first<{ c: number }>();
		expect(count?.c).toBe(50);
	});
});
