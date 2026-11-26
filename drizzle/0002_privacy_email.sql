ALTER TABLE `marks` ADD COLUMN `visibility` text NOT NULL DEFAULT 'private';
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `share_predictions` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `credentials` ADD COLUMN `verified_at` integer;
--> statement-breakpoint
CREATE TABLE `email_tokens` (`token_hash` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, `purpose` text NOT NULL, `expires_at` integer NOT NULL, `created_at` integer NOT NULL, FOREIGN KEY (`user_id`) REFERENCES `users`(`id`));
--> statement-breakpoint
CREATE INDEX `email_tokens_user_idx` ON `email_tokens` (`user_id`);
--> statement-breakpoint
UPDATE `credentials` SET `verified_at`=`created_at`;
