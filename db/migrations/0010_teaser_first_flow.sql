ALTER TABLE "consent" ALTER COLUMN "lead_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_file" ALTER COLUMN "lead_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "snapshot_run" ADD COLUMN "unlocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "snapshot_run" ADD COLUMN "viewed_at" timestamp with time zone;