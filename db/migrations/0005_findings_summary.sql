ALTER TABLE "snapshot_finding" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshot_finding" ADD COLUMN "next_action" text NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshot_run" ADD COLUMN "summary" jsonb;