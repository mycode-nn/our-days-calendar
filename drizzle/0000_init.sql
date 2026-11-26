CREATE TABLE `couples` (`id` text PRIMARY KEY NOT NULL, `invite_code` text, `invite_expires` integer, `created_at` integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `couples_invite_code_unique` ON `couples` (`invite_code`);
--> statement-breakpoint
CREATE TABLE `users` (`id` text PRIMARY KEY NOT NULL, `email` text NOT NULL, `name` text NOT NULL, `cycle_length` integer NOT NULL DEFAULT 28, `couple_id` text, `created_at` integer NOT NULL, FOREIGN KEY (`couple_id`) REFERENCES `couples`(`id`));
--> statement-breakpoint
CREATE INDEX `users_couple_idx` ON `users` (`couple_id`);
--> statement-breakpoint
CREATE TABLE `marks` (`user_id` text NOT NULL, `couple_id` text, `date` text NOT NULL, `type` text NOT NULL, `created_at` integer NOT NULL, PRIMARY KEY (`user_id`,`date`,`type`), FOREIGN KEY (`user_id`) REFERENCES `users`(`id`), FOREIGN KEY (`couple_id`) REFERENCES `couples`(`id`));
--> statement-breakpoint
CREATE INDEX `marks_couple_date_idx` ON `marks` (`couple_id`,`date`);
--> statement-breakpoint
CREATE TABLE `notes` (`id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, `couple_id` text, `date` text NOT NULL, `start_time` text, `end_time` text, `content` text NOT NULL, `visibility` text NOT NULL DEFAULT 'private', `created_at` integer NOT NULL, `updated_at` integer NOT NULL, FOREIGN KEY (`user_id`) REFERENCES `users`(`id`), FOREIGN KEY (`couple_id`) REFERENCES `couples`(`id`));
--> statement-breakpoint
CREATE INDEX `notes_couple_date_idx` ON `notes` (`couple_id`,`date`);
