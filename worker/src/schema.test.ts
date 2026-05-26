import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { memories, projects, sessions } from "./schema";

describe("schema definitions", () => {
	describe("projects table", () => {
		it("has correct columns", () => {
			const config = getTableConfig(projects);
			const columnNames = config.columns.map((c) => c.name);
			expect(columnNames).toContain("id");
			expect(columnNames).toContain("name");
			expect(columnNames).toContain("session_count");
			expect(columnNames).toContain("created_at");
			expect(columnNames).toContain("last_seen");
		});

		it("has id as primary key", () => {
			const config = getTableConfig(projects);
			const pkCol = config.columns.find((c) => c.name === "id");
			expect(pkCol?.primary).toBe(true);
		});

		it("has session_count default 0", () => {
			const config = getTableConfig(projects);
			const col = config.columns.find((c) => c.name === "session_count");
			expect(col?.default).toBe(0);
		});
	});

	describe("sessions table", () => {
		it("has correct columns", () => {
			const config = getTableConfig(sessions);
			const columnNames = config.columns.map((c) => c.name);
			expect(columnNames).toContain("id");
			expect(columnNames).toContain("project_id");
			expect(columnNames).toContain("source");
			expect(columnNames).toContain("raw_text");
			expect(columnNames).toContain("consolidated");
			expect(columnNames).toContain("extraction_error");
			expect(columnNames).toContain("token_count");
			expect(columnNames).toContain("metadata");
			expect(columnNames).toContain("created_at");
		});

		it("has id as primary key", () => {
			const config = getTableConfig(sessions);
			const pkCol = config.columns.find((c) => c.name === "id");
			expect(pkCol?.primary).toBe(true);
		});

		it("has consolidated default 0", () => {
			const config = getTableConfig(sessions);
			const col = config.columns.find((c) => c.name === "consolidated");
			expect(col?.default).toBe(0);
		});

		it("has a foreign key referencing projects(id)", () => {
			const config = getTableConfig(sessions);
			const fk = config.foreignKeys.find((fk) =>
				fk
					.reference()
					.columns.map((c) => c.name)
					.includes("project_id"),
			);
			expect(fk).toBeDefined();
			expect(fk?.reference().foreignColumns.map((c) => c.name)).toEqual(["id"]);
		});

		it("has an index on project_id", () => {
			const config = getTableConfig(sessions);
			const idx = config.indexes.find((i) => i.config.name === "idx_sessions_project_id");
			expect(idx).toBeDefined();
			expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(["project_id"]);
		});

		it("has a composite index on project_id + consolidated", () => {
			const config = getTableConfig(sessions);
			const idx = config.indexes.find(
				(i) => i.config.name === "idx_sessions_project_id_consolidated",
			);
			expect(idx).toBeDefined();
			expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
				"project_id",
				"consolidated",
			]);
		});
	});

	describe("memories table", () => {
		it("has correct columns", () => {
			const config = getTableConfig(memories);
			const columnNames = config.columns.map((c) => c.name);
			expect(columnNames).toContain("id");
			expect(columnNames).toContain("project_id");
			expect(columnNames).toContain("source_session");
			expect(columnNames).toContain("topic");
			expect(columnNames).toContain("content");
			expect(columnNames).toContain("confidence");
			expect(columnNames).toContain("curated");
			expect(columnNames).toContain("status");
			expect(columnNames).toContain("created_at");
			expect(columnNames).toContain("updated_at");
		});

		it("has id as primary key", () => {
			const config = getTableConfig(memories);
			const pkCol = config.columns.find((c) => c.name === "id");
			expect(pkCol?.primary).toBe(true);
		});

		it("has confidence default 0.0", () => {
			const config = getTableConfig(memories);
			const col = config.columns.find((c) => c.name === "confidence");
			expect(col?.default).toBe(0.0);
		});

		it("has curated default 0", () => {
			const config = getTableConfig(memories);
			const col = config.columns.find((c) => c.name === "curated");
			expect(col?.default).toBe(0);
		});

		it("has consolidated default 0", () => {
			const config = getTableConfig(memories);
			const col = config.columns.find((c) => c.name === "consolidated");
			expect(col?.default).toBe(0);
		});

		it("has status default 'active'", () => {
			const config = getTableConfig(memories);
			const col = config.columns.find((c) => c.name === "status");
			expect(col?.default).toBe("active");
		});

		it("has a foreign key referencing sessions(id)", () => {
			const config = getTableConfig(memories);
			const fk = config.foreignKeys.find((fk) =>
				fk
					.reference()
					.columns.map((c) => c.name)
					.includes("source_session"),
			);
			expect(fk).toBeDefined();
			expect(fk?.reference().foreignColumns.map((c) => c.name)).toEqual(["id"]);
		});

		it("has a composite index on project_id + topic", () => {
			const config = getTableConfig(memories);
			const idx = config.indexes.find((i) => i.config.name === "idx_memories_project_id_topic");
			expect(idx).toBeDefined();
			expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
				"project_id",
				"topic",
			]);
		});

		it("has a composite index on project_id + status", () => {
			const config = getTableConfig(memories);
			const idx = config.indexes.find((i) => i.config.name === "idx_memories_project_id_status");
			expect(idx).toBeDefined();
			expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
				"project_id",
				"status",
			]);
		});

		it("has a composite index on project_id + consolidated + curated", () => {
			const config = getTableConfig(memories);
			const idx = config.indexes.find(
				(i) => i.config.name === "idx_memories_project_id_consolidated_curated",
			);
			expect(idx).toBeDefined();
			expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
				"project_id",
				"consolidated",
				"curated",
			]);
		});
	});
});
