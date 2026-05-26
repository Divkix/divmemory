import { Database as BunDatabase } from "bun:sqlite";
import { BunSQLiteAdapter } from "./bun-sqlite-adapter";
import type { Database } from "./types";

const MEMORY_DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE projects (
	id TEXT PRIMARY KEY NOT NULL,
	name TEXT,
	session_count INTEGER DEFAULT 0,
	created_at TEXT,
	last_seen TEXT,
	consolidation_in_progress INTEGER DEFAULT 0
);
CREATE TABLE sessions (
	id TEXT PRIMARY KEY NOT NULL,
	project_id TEXT NOT NULL,
	source TEXT,
	raw_text TEXT,
	consolidated INTEGER DEFAULT 0,
	extraction_error TEXT,
	token_count INTEGER,
	metadata TEXT,
	created_at TEXT,
	FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE INDEX idx_sessions_project_id ON sessions (project_id);
CREATE INDEX idx_sessions_project_id_consolidated ON sessions (project_id, consolidated);
CREATE TABLE memories (
	id TEXT PRIMARY KEY NOT NULL,
	project_id TEXT NOT NULL,
	source_session TEXT NOT NULL,
	topic TEXT,
	content TEXT,
	confidence REAL DEFAULT 0,
	curated INTEGER DEFAULT 0,
	consolidated INTEGER DEFAULT 0,
	status TEXT DEFAULT 'active',
	created_at TEXT,
	updated_at TEXT,
	FOREIGN KEY (source_session) REFERENCES sessions(id)
);
CREATE INDEX idx_memories_project_id_topic ON memories (project_id, topic);
CREATE INDEX idx_memories_project_id_status ON memories (project_id, status);
CREATE INDEX idx_memories_project_id_consolidated_curated ON memories (project_id, consolidated, curated);
`;

/** Fast in-memory SQLite-backed adapter (no D1 / no persisted file). */
export class InMemoryAdapter extends BunSQLiteAdapter {
	constructor() {
		const sqlite = new BunDatabase(":memory:");
		sqlite.exec(MEMORY_DDL);
		super(sqlite);
	}
}

export function createInMemoryDatabase(): Database {
	return new InMemoryAdapter().asDatabase();
}
