ALTER TABLE `memories` ADD `consolidated` integer DEFAULT 0;--> statement-breakpoint
CREATE INDEX `idx_memories_project_id_consolidated_curated` ON `memories` (`project_id`,`consolidated`,`curated`);--> statement-breakpoint
UPDATE `memories` SET `consolidated` = 1 WHERE `curated` = 0;