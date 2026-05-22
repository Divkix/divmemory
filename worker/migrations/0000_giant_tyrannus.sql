CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_session` text NOT NULL,
	`topic` text,
	`content` text,
	`confidence` real DEFAULT 0,
	`curated` integer DEFAULT 0,
	`status` text DEFAULT 'active',
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`source_session`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_memories_project_id_topic` ON `memories` (`project_id`,`topic`);--> statement-breakpoint
CREATE INDEX `idx_memories_project_id_status` ON `memories` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`session_count` integer DEFAULT 0,
	`created_at` text,
	`last_seen` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source` text,
	`raw_text` text,
	`consolidated` integer DEFAULT 0,
	`extraction_error` text,
	`token_count` integer,
	`metadata` text,
	`created_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_project_id` ON `sessions` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_id_consolidated` ON `sessions` (`project_id`,`consolidated`);