CREATE TABLE `feature_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feature_id` integer NOT NULL,
	`step_index` integer NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feature_steps_feature_step_unique` ON `feature_steps` (`feature_id`,`step_index`);--> statement-breakpoint
CREATE INDEX `feature_steps_feature_id_idx` ON `feature_steps` (`feature_id`);--> statement-breakpoint
ALTER TABLE `agent_logs` ADD `meta` text;--> statement-breakpoint
ALTER TABLE `features` ADD `note_path` text;--> statement-breakpoint
ALTER TABLE `features` ADD `attempt_count` integer DEFAULT 0 NOT NULL;