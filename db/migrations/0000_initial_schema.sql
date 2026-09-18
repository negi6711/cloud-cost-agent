CREATE TABLE "admin_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"snapshot_run_id" uuid,
	"author_email" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_event_actor_type_ck" CHECK (actor_type IN ('prospect', 'admin', 'worker', 'system'))
);
--> statement-breakpoint
CREATE TABLE "consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"purpose" text NOT NULL,
	"disclosure_version" text NOT NULL,
	"granted" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_provider_ck" CHECK (provider IN ('typesafe', 'openai'))
);
--> statement-breakpoint
CREATE TABLE "evidence_packet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"snapshot_run_id" uuid NOT NULL,
	"evidence_id" text NOT NULL,
	"version" text NOT NULL,
	"sha256" text NOT NULL,
	"packet" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_packet_uq" UNIQUE("tenant_id","snapshot_run_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_idempotency_uq" UNIQUE("idempotency_key"),
	CONSTRAINT "job_status_ck" CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
	CONSTRAINT "job_attempts_ck" CHECK ("job"."attempts" >= 0 AND "job"."attempts" <= "job"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "lead" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"first_name" text NOT NULL,
	"company_name" text NOT NULL,
	"company_website" text NOT NULL,
	"company_domain" text NOT NULL,
	"role" text NOT NULL,
	"country" text NOT NULL,
	"provider" text NOT NULL,
	"spend_band" text NOT NULL,
	"biggest_problem" text NOT NULL,
	"contact_permission" boolean NOT NULL,
	"consent_or_contact_basis" text NOT NULL,
	"aws_account_count" text,
	"kubernetes_usage" text,
	"ai_gpu_usage" text,
	"recent_bill_shock" text,
	"desired_outcome" text,
	"pilot_interest" text,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "lead_spend_band_ck" CHECK (spend_band IN ('under_5k', '5k_10k', '10k_25k', '25k_75k', '75k_100k', 'over_100k', 'not_sure')),
	CONSTRAINT "lead_status_ck" CHECK (status IN ('new', 'needs_clarification', 'snapshot_sent', 'pilot_requested', 'not_qualified', 'follow_up_later')),
	CONSTRAINT "lead_contact_permission_ck" CHECK ("lead"."contact_permission" = true)
);
--> statement-breakpoint
CREATE TABLE "model_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"snapshot_run_id" uuid NOT NULL,
	"evidence_id" text NOT NULL,
	"provider" text NOT NULL,
	"model_requested" text NOT NULL,
	"model_reported" text,
	"request_id" text,
	"question_set_version" text NOT NULL,
	"packet_sha256" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer NOT NULL,
	"latency_ms" integer,
	"input_tokens" integer,
	"answers" jsonb,
	"error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pilot_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"snapshot_run_id" uuid,
	"preferred_price" text,
	"message" text,
	"manual_review_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"snapshot_run_id" uuid NOT NULL,
	"evidence_id" text NOT NULL,
	"rank" integer NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"explanation" text NOT NULL,
	"observed_value" numeric,
	"baseline_value" numeric,
	"delta_value" numeric,
	"estimated_monthly_impact_low" numeric,
	"estimated_monthly_impact_high" numeric,
	"owner" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"jev_category" text,
	"jev_owner" text,
	"jev_urgency" text,
	"jev_risk" text,
	"jev_confidence" numeric,
	"jev_probabilities" jsonb,
	"model_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_status" text NOT NULL,
	"final_category" text NOT NULL,
	"policy_status" text NOT NULL,
	"policy_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_required" boolean NOT NULL,
	"explanation_source" text NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshot_finding_evidence_uq" UNIQUE("tenant_id","snapshot_run_id","evidence_id"),
	CONSTRAINT "snapshot_finding_final_category_ck" CHECK (final_category IN ('INVESTIGATE', 'REQUEST_EVIDENCE', 'MONITOR', 'ESCALATE')),
	CONSTRAINT "snapshot_finding_jev_category_ck" CHECK (jev_category IS NULL OR jev_category IN ('INVESTIGATE', 'REQUEST_EVIDENCE', 'MONITOR', 'ESCALATE'))
);
--> statement-breakpoint
CREATE TABLE "snapshot_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_file_id" uuid NOT NULL,
	"parser_version" text NOT NULL,
	"status" text NOT NULL,
	"rows_seen" integer,
	"rows_accepted" integer,
	"rows_rejected" integer,
	"total_cost" numeric,
	"currency" text,
	"data_readiness_score" numeric,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_packet_version" text,
	"evidence_packet_sha256" text,
	"question_set_version" text NOT NULL,
	"model_status" text,
	"consent_basis" text,
	"explanation_provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "snapshot_run_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "snapshot_run_version_uq" UNIQUE("tenant_id","source_file_id","parser_version","question_set_version"),
	CONSTRAINT "snapshot_run_status_ck" CHECK (status IN ('queued', 'parsing', 'analyzing', 'classifying', 'completed', 'insufficient_data', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "source_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"status" text NOT NULL,
	"dimension" text,
	"idempotency_key" text NOT NULL,
	"detected_period_start" date,
	"detected_period_end" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_file_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "source_file_idempotency_uq" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "source_file_storage_key_uq" UNIQUE("storage_key"),
	CONSTRAINT "source_file_status_ck" CHECK (status IN ('uploaded', 'validating', 'rejected', 'accepted', 'processed', 'failed')),
	CONSTRAINT "source_file_size_ck" CHECK ("source_file"."size_bytes" > 0),
	CONSTRAINT "source_file_sha256_ck" CHECK ("source_file"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_self_ck" CHECK ("tenant"."tenant_id" = "tenant"."id")
);
--> statement-breakpoint
ALTER TABLE "admin_note" ADD CONSTRAINT "admin_note_lead_fk" FOREIGN KEY ("tenant_id","lead_id") REFERENCES "public"."lead"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_lead_fk" FOREIGN KEY ("tenant_id","lead_id") REFERENCES "public"."lead"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_packet" ADD CONSTRAINT "evidence_packet_run_fk" FOREIGN KEY ("tenant_id","snapshot_run_id") REFERENCES "public"."snapshot_run"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_run_fk" FOREIGN KEY ("tenant_id","snapshot_run_id") REFERENCES "public"."snapshot_run"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilot_request" ADD CONSTRAINT "pilot_request_lead_fk" FOREIGN KEY ("tenant_id","lead_id") REFERENCES "public"."lead"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_finding" ADD CONSTRAINT "snapshot_finding_run_fk" FOREIGN KEY ("tenant_id","snapshot_run_id") REFERENCES "public"."snapshot_run"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_run" ADD CONSTRAINT "snapshot_run_source_file_fk" FOREIGN KEY ("tenant_id","source_file_id") REFERENCES "public"."source_file"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_file" ADD CONSTRAINT "source_file_lead_fk" FOREIGN KEY ("tenant_id","lead_id") REFERENCES "public"."lead"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_tenant_idx" ON "audit_event" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "consent_lead_idx" ON "consent" USING btree ("tenant_id","lead_id");--> statement-breakpoint
CREATE INDEX "job_claim_idx" ON "job" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "lead_email_idx" ON "lead" USING btree ("email");--> statement-breakpoint
CREATE INDEX "lead_created_idx" ON "lead" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_call_cache_idx" ON "model_call" USING btree ("packet_sha256","question_set_version","model_requested","status");--> statement-breakpoint
CREATE INDEX "source_file_lead_idx" ON "source_file" USING btree ("tenant_id","lead_id");