CREATE TABLE `fake_invoices` (
	`payment_hash` text PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`seq` integer NOT NULL,
	`invoice` text NOT NULL,
	`preimage` text NOT NULL,
	`amount_sat` integer NOT NULL,
	`memo` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`paid_at` text,
	`paid_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fake_invoices_account_seq_uq` ON `fake_invoices` (`account`,`seq`);--> statement-breakpoint
CREATE INDEX `fake_invoices_paid_by_idx` ON `fake_invoices` (`paid_by`);--> statement-breakpoint
CREATE TABLE `payout_runs` (
	`attestation_id` text PRIMARY KEY NOT NULL,
	`site` text NOT NULL,
	`date` text NOT NULL,
	`outcome` text NOT NULL,
	`status` text NOT NULL,
	`replay` integer DEFAULT false NOT NULL,
	`wallet` text NOT NULL,
	`policies` integer DEFAULT 0 NOT NULL,
	`xof_per_btc` integer,
	`price_as_of` text,
	`price_stale` integer,
	`balance_sat` integer,
	`reserve_floor_sat` integer,
	`daily_cap_sat` integer,
	`paid_today_sat` integer,
	`due_sat` integer DEFAULT 0 NOT NULL,
	`available_sat` integer,
	`plan_sat` integer DEFAULT 0 NOT NULL,
	`shortfall_sat` integer DEFAULT 0 NOT NULL,
	`factor_ppm` integer,
	`limited_by` text,
	`verification` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`attestation_id`) REFERENCES `attestations`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payout_runs_created_idx` ON `payout_runs` (`created_at`);--> statement-breakpoint
-- hand-edited: SQLite needs a default to add a NOT NULL column. Both tables were still empty
-- (Phase 3 never wrote them); the app always sets wallet explicitly.
ALTER TABLE `deposits` ADD `wallet` text DEFAULT 'fake' NOT NULL;--> statement-breakpoint
ALTER TABLE `payouts` ADD `wallet` text DEFAULT 'fake' NOT NULL;--> statement-breakpoint
ALTER TABLE `payouts` ADD `invoice_expires_at` text;--> statement-breakpoint
ALTER TABLE `payouts` ADD `fee_sat` integer;--> statement-breakpoint
ALTER TABLE `payouts` ADD `paid_at` text;--> statement-breakpoint
ALTER TABLE `payouts` ADD `receipt_publish_result` text;--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_payment_hash_uq` ON `payouts` (`payment_hash`);--> statement-breakpoint
ALTER TABLE `policies` ADD `weeks` integer DEFAULT 1 NOT NULL;