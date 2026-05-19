import { foreignKey, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
	id: text("id").primaryKey(),
	name: text("name"),
	sessionCount: integer("session_count").default(0),
	createdAt: text("created_at"),
	lastSeen: text("last_seen"),
});

export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id").notNull(),
		source: text("source"),
		rawText: text("raw_text"),
		consolidated: integer("consolidated").default(0),
		extractionError: text("extraction_error"),
		tokenCount: integer("token_count"),
		metadata: text("metadata"),
		createdAt: text("created_at"),
	},
	(t) => [
		foreignKey({
			columns: [t.projectId],
			foreignColumns: [projects.id],
		}),
		index("idx_sessions_project_id").on(t.projectId),
		index("idx_sessions_project_id_consolidated").on(t.projectId, t.consolidated),
	],
);

export const memories = sqliteTable(
	"memories",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id").notNull(),
		sourceSession: text("source_session").notNull(),
		topic: text("topic"),
		content: text("content"),
		confidence: real("confidence").default(0.0),
		curated: integer("curated").default(0),
		status: text("status").default("active"),
		createdAt: text("created_at"),
		updatedAt: text("updated_at"),
	},
	(t) => [
		foreignKey({
			columns: [t.sourceSession],
			foreignColumns: [sessions.id],
		}),
		index("idx_memories_project_id_topic").on(t.projectId, t.topic),
		index("idx_memories_project_id_status").on(t.projectId, t.status),
	],
);
