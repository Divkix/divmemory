import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { memories, projects, sessions } from "../schema";
import { createInMemoryDatabase } from "./memory-adapter";
import { normalizeWriteResult } from "./types";

describe("BunSQLiteAdapter", () => {
	it("inserts and selects with schema inference", async () => {
		const db = createInMemoryDatabase();
		const now = new Date().toISOString();
		await db.client.insert(projects).values({
			id: "proj-a",
			name: "A",
			sessionCount: 0,
			createdAt: now,
			lastSeen: now,
		});
		const rows = await db.client.select().from(projects).where(eq(projects.id, "proj-a")).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe("proj-a");
	});

	it("atomic collects and runs writes", async () => {
		const db = createInMemoryDatabase();
		const now = new Date().toISOString();
		await db.atomic(async (collect) => {
			collect(
				db.client.insert(projects).values({
					id: "proj-b",
					name: "B",
					sessionCount: 0,
					createdAt: now,
					lastSeen: now,
				}),
			);
			collect(
				db.client.insert(sessions).values({
					id: "sess-1",
					projectId: "proj-b",
					source: "test",
					consolidated: 0,
					createdAt: now,
				}),
			);
			collect(
				db.client.insert(memories).values({
					id: "mem-1",
					projectId: "proj-b",
					sourceSession: "sess-1",
					topic: "general",
					content: "fact",
					confidence: 0.9,
					curated: 0,
					consolidated: 0,
					status: "active",
					createdAt: now,
					updatedAt: now,
				}),
			);
		});
		const count = await db.client.select().from(memories).all();
		expect(count).toHaveLength(1);
	});

	it("atomic rolls back on error", async () => {
		const db = createInMemoryDatabase();
		const now = new Date().toISOString();
		try {
			await db.atomic(async (collect) => {
				collect(
					db.client.insert(projects).values({
						id: "proj-c",
						name: "C",
						sessionCount: 0,
						createdAt: now,
						lastSeen: now,
					}),
				);
				collect(
					db.client.insert(sessions).values({
						id: "sess-c",
						projectId: "proj-c",
						source: "test",
						consolidated: 0,
						createdAt: now,
					}),
				);
				collect(
					db.client.insert(memories).values({
						id: "mem-c",
						projectId: "proj-c",
						sourceSession: "sess-c",
						topic: "general",
						content: "fact c",
						confidence: 0.9,
						curated: 0,
						consolidated: 0,
						status: "active",
						createdAt: now,
						updatedAt: now,
					}),
				);
				throw new Error("force rollback");
			});
		} catch (err) {
			expect((err as Error).message).toBe("force rollback");
		}
		const projRows = await db.client.select().from(projects).all();
		const memRows = await db.client.select().from(memories).all();
		expect(projRows).toHaveLength(0);
		expect(memRows).toHaveLength(0);
	});

	it("normalizeWriteResult maps rowsAffected", () => {
		expect(normalizeWriteResult({ rowsAffected: 2 })).toEqual({ changes: 2 });
		expect(normalizeWriteResult({ changes: 3 })).toEqual({ changes: 3 });
	});
});

describe("InMemoryAdapter", () => {});
