/**
 * Database schema — single source of truth for migrations (drizzle-kit) and the web app.
 * The Python worker reads and writes these tables with explicit SQL; a contract test keeps it honest.
 *
 * Invariants:
 * - Every table carries `tenant_id`. Row-level security (migration 0001) enforces
 *   `tenant_id = current_setting('app.tenant_id')` for the application role.
 * - Child rows reference their parent through a composite (tenant_id, parent_id) foreign key, so a
 *   row can never point at another tenant's parent.
 * - Money is `numeric` (read as string), never floating point.
 * - Deleting a source file cascades to runs, findings, evidence packets and model calls.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  AUDIT_ACTOR_TYPES,
  CONSENT_PROVIDERS,
  DECISION_CATEGORIES,
  JOB_STATUSES,
  LEAD_STATUSES,
  SOURCE_FILE_STATUSES,
  SPEND_BANDS,
  SNAPSHOT_RUN_STATUSES,
} from "@cca/config";

const id = () => uuid("id").primaryKey().defaultRandom();
const tenantId = () => uuid("tenant_id").notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** SQL `IN (...)` list for a CHECK constraint over a fixed vocabulary. */
function oneOf(column: string, values: readonly string[]) {
  const list = values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", ");
  return sql.raw(`${column} IN (${list})`);
}

// ------------------------------------------------------------------ tenancy ---

export const tenant = pgTable(
  "tenant",
  {
    id: id(),
    // A tenant is its own tenant: this lets RLS treat the tenant table like every other table.
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("tenant_self_ck", sql`${t.tenantId} = ${t.id}`)],
);

// -------------------------------------------------------------------- leads ---

export const lead = pgTable(
  "lead",
  {
    id: id(),
    tenantId: tenantId(),
    email: text("email").notNull(),
    firstName: text("first_name").notNull(),
    companyName: text("company_name").notNull(),
    companyWebsite: text("company_website").notNull(),
    companyDomain: text("company_domain").notNull(),
    role: text("role").notNull(),
    country: text("country").notNull(),
    provider: text("provider").notNull(),
    spendBand: text("spend_band").notNull(),
    biggestProblem: text("biggest_problem").notNull(),
    contactPermission: boolean("contact_permission").notNull(),
    consentOrContactBasis: text("consent_or_contact_basis").notNull(),
    awsAccountCount: text("aws_account_count"),
    kubernetesUsage: text("kubernetes_usage"),
    aiGpuUsage: text("ai_gpu_usage"),
    recentBillShock: text("recent_bill_shock"),
    desiredOutcome: text("desired_outcome"),
    pilotInterest: text("pilot_interest"),
    status: text("status").notNull().default("new"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("lead_tenant_id_uq").on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenant.id], name: "lead_tenant_fk" }).onDelete(
      "cascade",
    ),
    check("lead_spend_band_ck", oneOf("spend_band", SPEND_BANDS)),
    check("lead_status_ck", oneOf("status", LEAD_STATUSES)),
    check("lead_contact_permission_ck", sql`${t.contactPermission} = true`),
    index("lead_email_idx").on(t.email),
    index("lead_created_idx").on(t.createdAt),
  ],
);

export const consent = pgTable(
  "consent",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    provider: text("provider").notNull(),
    purpose: text("purpose").notNull(),
    disclosureVersion: text("disclosure_version").notNull(),
    granted: boolean("granted").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.leadId],
      foreignColumns: [lead.tenantId, lead.id],
      name: "consent_lead_fk",
    }).onDelete("cascade"),
    check("consent_provider_ck", oneOf("provider", CONSENT_PROVIDERS)),
    index("consent_lead_idx").on(t.tenantId, t.leadId),
  ],
);

// ------------------------------------------------------------ source files ---

export const sourceFile = pgTable(
  "source_file",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    storageKey: text("storage_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    status: text("status").notNull(),
    dimension: text("dimension"),
    idempotencyKey: text("idempotency_key").notNull(),
    detectedPeriodStart: date("detected_period_start"),
    detectedPeriodEnd: date("detected_period_end"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("source_file_tenant_id_uq").on(t.tenantId, t.id),
    unique("source_file_idempotency_uq").on(t.tenantId, t.idempotencyKey),
    unique("source_file_storage_key_uq").on(t.storageKey),
    foreignKey({
      columns: [t.tenantId, t.leadId],
      foreignColumns: [lead.tenantId, lead.id],
      name: "source_file_lead_fk",
    }).onDelete("cascade"),
    check("source_file_status_ck", oneOf("status", SOURCE_FILE_STATUSES)),
    check("source_file_size_ck", sql`${t.sizeBytes} > 0`),
    check("source_file_sha256_ck", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    index("source_file_lead_idx").on(t.tenantId, t.leadId),
  ],
);

// -------------------------------------------------------------------- jobs ---

export const job = pgTable(
  "job",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastErrorClass: text("last_error_class"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("job_idempotency_uq").on(t.idempotencyKey),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenant.id], name: "job_tenant_fk" }).onDelete(
      "cascade",
    ),
    check("job_status_ck", oneOf("status", JOB_STATUSES)),
    check("job_attempts_ck", sql`${t.attempts} >= 0 AND ${t.attempts} <= ${t.maxAttempts}`),
    index("job_claim_idx").on(t.status, t.runAfter),
  ],
);

// --------------------------------------------------------------- snapshots ---

export const snapshotRun = pgTable(
  "snapshot_run",
  {
    id: id(),
    tenantId: tenantId(),
    sourceFileId: uuid("source_file_id").notNull(),
    parserVersion: text("parser_version").notNull(),
    status: text("status").notNull(),
    rowsSeen: integer("rows_seen"),
    rowsAccepted: integer("rows_accepted"),
    rowsRejected: integer("rows_rejected"),
    totalCost: numeric("total_cost"),
    currency: text("currency"),
    dataReadinessScore: numeric("data_readiness_score"),
    warnings: jsonb("warnings").notNull().default([]),
    evidencePacketVersion: text("evidence_packet_version"),
    evidencePacketSha256: text("evidence_packet_sha256"),
    questionSetVersion: text("question_set_version").notNull(),
    modelStatus: text("model_status"),
    consentBasis: text("consent_basis"),
    explanationProvider: text("explanation_provider"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("snapshot_run_tenant_id_uq").on(t.tenantId, t.id),
    unique("snapshot_run_version_uq").on(
      t.tenantId,
      t.sourceFileId,
      t.parserVersion,
      t.questionSetVersion,
    ),
    foreignKey({
      columns: [t.tenantId, t.sourceFileId],
      foreignColumns: [sourceFile.tenantId, sourceFile.id],
      name: "snapshot_run_source_file_fk",
    }).onDelete("cascade"),
    check("snapshot_run_status_ck", oneOf("status", SNAPSHOT_RUN_STATUSES)),
  ],
);

export const snapshotFinding = pgTable(
  "snapshot_finding",
  {
    id: id(),
    tenantId: tenantId(),
    snapshotRunId: uuid("snapshot_run_id").notNull(),
    evidenceId: text("evidence_id").notNull(),
    rank: integer("rank").notNull(),
    category: text("category").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    observedValue: numeric("observed_value"),
    baselineValue: numeric("baseline_value"),
    deltaValue: numeric("delta_value"),
    estimatedMonthlyImpactLow: numeric("estimated_monthly_impact_low"),
    estimatedMonthlyImpactHigh: numeric("estimated_monthly_impact_high"),
    owner: text("owner"),
    evidence: jsonb("evidence").notNull().default([]),
    missingEvidence: jsonb("missing_evidence").notNull().default([]),
    jevCategory: text("jev_category"),
    jevOwner: text("jev_owner"),
    jevUrgency: text("jev_urgency"),
    jevRisk: text("jev_risk"),
    jevConfidence: numeric("jev_confidence"),
    jevProbabilities: jsonb("jev_probabilities"),
    modelEvidenceIds: jsonb("model_evidence_ids").notNull().default([]),
    modelStatus: text("model_status").notNull(),
    finalCategory: text("final_category").notNull(),
    policyStatus: text("policy_status").notNull(),
    policyReasons: jsonb("policy_reasons").notNull().default([]),
    reviewRequired: boolean("review_required").notNull(),
    explanationSource: text("explanation_source").notNull(),
    status: text("status").notNull().default("preview"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("snapshot_finding_evidence_uq").on(t.tenantId, t.snapshotRunId, t.evidenceId),
    foreignKey({
      columns: [t.tenantId, t.snapshotRunId],
      foreignColumns: [snapshotRun.tenantId, snapshotRun.id],
      name: "snapshot_finding_run_fk",
    }).onDelete("cascade"),
    // Billing-only data can never yield a destructive category, whatever the model says.
    check("snapshot_finding_final_category_ck", oneOf("final_category", DECISION_CATEGORIES)),
    check(
      "snapshot_finding_jev_category_ck",
      sql`jev_category IS NULL OR ${oneOf("jev_category", DECISION_CATEGORIES)}`,
    ),
  ],
);

export const evidencePacket = pgTable(
  "evidence_packet",
  {
    id: id(),
    tenantId: tenantId(),
    snapshotRunId: uuid("snapshot_run_id").notNull(),
    evidenceId: text("evidence_id").notNull(),
    version: text("version").notNull(),
    sha256: text("sha256").notNull(),
    packet: jsonb("packet").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("evidence_packet_uq").on(t.tenantId, t.snapshotRunId, t.evidenceId),
    foreignKey({
      columns: [t.tenantId, t.snapshotRunId],
      foreignColumns: [snapshotRun.tenantId, snapshotRun.id],
      name: "evidence_packet_run_fk",
    }).onDelete("cascade"),
  ],
);

export const modelCall = pgTable(
  "model_call",
  {
    id: id(),
    tenantId: tenantId(),
    snapshotRunId: uuid("snapshot_run_id").notNull(),
    evidenceId: text("evidence_id").notNull(),
    provider: text("provider").notNull(),
    modelRequested: text("model_requested").notNull(),
    modelReported: text("model_reported"),
    requestId: text("request_id"),
    questionSetVersion: text("question_set_version").notNull(),
    packetSha256: text("packet_sha256").notNull(),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull(),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    answers: jsonb("answers"),
    errorClass: text("error_class"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.snapshotRunId],
      foreignColumns: [snapshotRun.tenantId, snapshotRun.id],
      name: "model_call_run_fk",
    }).onDelete("cascade"),
    // Replay/idempotency lookup: a stored success for this packet+questions+model is reused.
    index("model_call_cache_idx").on(t.packetSha256, t.questionSetVersion, t.modelRequested, t.status),
  ],
);

// ------------------------------------------------------------ founder ops ---

export const adminNote = pgTable(
  "admin_note",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    snapshotRunId: uuid("snapshot_run_id"),
    authorEmail: text("author_email").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.leadId],
      foreignColumns: [lead.tenantId, lead.id],
      name: "admin_note_lead_fk",
    }).onDelete("cascade"),
  ],
);

export const pilotRequest = pgTable(
  "pilot_request",
  {
    id: id(),
    tenantId: tenantId(),
    leadId: uuid("lead_id").notNull(),
    snapshotRunId: uuid("snapshot_run_id"),
    preferredPrice: text("preferred_price"),
    message: text("message"),
    manualReviewOnly: boolean("manual_review_only").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.leadId],
      foreignColumns: [lead.tenantId, lead.id],
      name: "pilot_request_lead_fk",
    }).onDelete("cascade"),
  ],
);

export const auditEvent = pgTable(
  "audit_event",
  {
    id: id(),
    tenantId: tenantId(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    // No FK to tenant: audit events must survive deletion of the data they describe.
    check("audit_event_actor_type_ck", oneOf("actor_type", AUDIT_ACTOR_TYPES)),
    index("audit_event_tenant_idx").on(t.tenantId, t.createdAt),
  ],
);
