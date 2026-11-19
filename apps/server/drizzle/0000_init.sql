CREATE TABLE `announcements` (
	`event_id` text PRIMARY KEY NOT NULL,
	`site` text NOT NULL,
	`date` text NOT NULL,
	`replay_run_id` text,
	`oracle_pubkey` text NOT NULL,
	`nonce_point` text NOT NULL,
	`nonce_enc` text,
	`nostr_id` text NOT NULL,
	`event_json` text NOT NULL,
	`created_at` text NOT NULL,
	`published_at` text,
	`publish_result` text,
	FOREIGN KEY (`replay_run_id`) REFERENCES `replay_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `announcements_nostr_id_unique` ON `announcements` (`nostr_id`);--> statement-breakpoint
CREATE INDEX `announcements_site_date_idx` ON `announcements` (`site`,`date`);--> statement-breakpoint
CREATE TABLE `attestations` (
	`event_id` text PRIMARY KEY NOT NULL,
	`site` text NOT NULL,
	`date` text NOT NULL,
	`replay_run_id` text,
	`outcome` text NOT NULL,
	`decisive_m` real,
	`nostr_id` text NOT NULL,
	`event_json` text NOT NULL,
	`created_at` text NOT NULL,
	`published_at` text,
	`publish_result` text,
	FOREIGN KEY (`event_id`) REFERENCES `announcements`(`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replay_run_id`) REFERENCES `replay_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attestations_nostr_id_unique` ON `attestations` (`nostr_id`);--> statement-breakpoint
CREATE INDEX `attestations_site_date_idx` ON `attestations` (`site`,`date`);--> statement-breakpoint
CREATE TABLE `crews` (
	`id` text PRIMARY KEY NOT NULL,
	`site` text NOT NULL,
	`pseudonym` text NOT NULL,
	`status_code` text NOT NULL,
	`phone_enc` text,
	`ln_address_enc` text,
	`holder_salt` text NOT NULL,
	`demo` integer DEFAULT true NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	FOREIGN KEY (`site`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crews_pseudonym_unique` ON `crews` (`pseudonym`);--> statement-breakpoint
CREATE UNIQUE INDEX `crews_status_code_unique` ON `crews` (`status_code`);--> statement-breakpoint
CREATE INDEX `crews_site_idx` ON `crews` (`site`);--> statement-breakpoint
CREATE TABLE `deposits` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`amount_sat` integer NOT NULL,
	`amount_fcfa` integer,
	`xof_per_btc` integer,
	`payment_hash` text,
	`invoice` text,
	`zap_receipt_id` text,
	`policy_id` text,
	`crew_id` text,
	`site` text,
	`memo` text,
	`demo` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	`paid_at` text,
	`expires_at` text,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deposits_payment_hash_unique` ON `deposits` (`payment_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `deposits_zap_receipt_id_unique` ON `deposits` (`zap_receipt_id`);--> statement-breakpoint
CREATE INDEX `deposits_status_idx` ON `deposits` (`status`);--> statement-breakpoint
CREATE TABLE `forecasts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`model` text NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`fetched_at` text NOT NULL,
	`sha256` text,
	`body` text,
	`window_max_m` real,
	`valid_hours` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`event_id`) REFERENCES `announcements`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forecasts_event_model_uq` ON `forecasts` (`event_id`,`model`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job` text NOT NULL,
	`site` text,
	`date` text,
	`status` text NOT NULL,
	`detail` text,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_runs_job_started_idx` ON `job_runs` (`job`,`started_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`crew_id` text NOT NULL,
	`attestation_id` text NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`provider_id` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attestation_id`) REFERENCES `attestations`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_crew_attestation_channel_uq` ON `notifications` (`crew_id`,`attestation_id`,`channel`);--> statement-breakpoint
CREATE TABLE `payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_id` text NOT NULL,
	`attestation_id` text NOT NULL,
	`site` text NOT NULL,
	`amount_fcfa` integer NOT NULL,
	`due_sat` integer NOT NULL,
	`amount_sat` integer NOT NULL,
	`xof_per_btc` integer NOT NULL,
	`factor_ppm` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`invoice` text,
	`payment_hash` text,
	`preimage` text,
	`error` text,
	`receipt_json` text,
	`receipt_published_at` text,
	`replay` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attestation_id`) REFERENCES `attestations`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_policy_attestation_uq` ON `payouts` (`policy_id`,`attestation_id`);--> statement-breakpoint
CREATE INDEX `payouts_status_idx` ON `payouts` (`status`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`crew_id` text NOT NULL,
	`site` text NOT NULL,
	`payout_fcfa` integer NOT NULL,
	`threshold_cm` integer NOT NULL,
	`premium_fcfa` integer NOT NULL,
	`funded_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`paid_at` text,
	`active_from` text,
	`active_until` text,
	`demo` integer DEFAULT true NOT NULL,
	`event_json` text,
	`published_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	FOREIGN KEY (`crew_id`) REFERENCES `crews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `policies_site_status_idx` ON `policies` (`site`,`status`);--> statement-breakpoint
CREATE TABLE `replay_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`site` text NOT NULL,
	`date` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`threshold_cm` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);
