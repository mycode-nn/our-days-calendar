ALTER TABLE `users` ADD COLUMN `phone` text;
--> statement-breakpoint
CREATE TABLE `credentials` (`user_id` text PRIMARY KEY NOT NULL, `identifier` text NOT NULL UNIQUE, `password_salt` text NOT NULL, `password_hash` text NOT NULL, `recovery_salt` text NOT NULL, `recovery_hash` text NOT NULL, `created_at` integer NOT NULL, FOREIGN KEY (`user_id`) REFERENCES `users`(`id`));
--> statement-breakpoint
CREATE TABLE `auth_sessions` (`token_hash` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, `expires_at` integer NOT NULL, `created_at` integer NOT NULL, FOREIGN KEY (`user_id`) REFERENCES `users`(`id`));
--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);
--> statement-breakpoint
CREATE TABLE `auth_throttle` (`key` text PRIMARY KEY NOT NULL, `count` integer NOT NULL, `expires_at` integer NOT NULL);
