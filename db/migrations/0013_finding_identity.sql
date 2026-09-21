ALTER TABLE "snapshot_finding" ADD COLUMN "finding_key" text;--> statement-breakpoint
ALTER TABLE "snapshot_finding" ADD COLUMN "dimension" text;--> statement-breakpoint
ALTER TABLE "snapshot_finding" ADD COLUMN "label" text;--> statement-breakpoint
CREATE INDEX "snapshot_finding_key_idx" ON "snapshot_finding" USING btree ("tenant_id","finding_key");