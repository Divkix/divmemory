import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

/** Build an in-memory SQLite DB wrapped by Drizzle for tests.
 *  Creates all tables, indexes, and returns the raw sqlite handle + drizzle db. */
export function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite);
	sqlite.exec(`
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
			status TEXT DEFAULT 'active',
			created_at TEXT,
			updated_at TEXT,
			FOREIGN KEY (source_session) REFERENCES sessions(id)
		);
		CREATE INDEX idx_memories_project_id_topic ON memories (project_id, topic);
		CREATE INDEX idx_memories_project_id_status ON memories (project_id, status);
	`);
	return { sqlite, db };
}
