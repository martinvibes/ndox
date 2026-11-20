CREATE TABLE `bulletins` (
	`date` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`model` text,
	`event_json` text,
	`nostr_id` text,
	`published_at` text,
	`publish_result` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `notifications` ADD `delivery_status` text;