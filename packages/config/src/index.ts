/**
 * Fixed product vocabularies from the MVP 0 specification (docs/product-spec.md §5, §7).
 * The Python worker defines the same values; a contract test keeps them in sync.
 */

export const SPEND_BANDS = [
  "under_5k",
  "5k_10k",
  "10k_25k",
  "25k_75k",
  "75k_100k",
  "over_100k",
  "not_sure",
] as const;
export type SpendBand = (typeof SPEND_BANDS)[number];

export const SPEND_BAND_LABELS: Record<SpendBand, string> = {
  under_5k: "Under $5k/month",
  "5k_10k": "$5k–$10k/month",
  "10k_25k": "$10k–$25k/month",
  "25k_75k": "$25k–$75k/month",
  "75k_100k": "$75k–$100k/month",
  over_100k: "Over $100k/month",
  not_sure: "Not sure",
};

/** The only live decision categories. RESIZE / DELETE / STOP / BUY COMMITMENT are not representable. */
export const DECISION_CATEGORIES = [
  "INVESTIGATE",
  "REQUEST_EVIDENCE",
  "MONITOR",
  "ESCALATE",
] as const;
export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

export const DECISION_CATEGORY_LABELS: Record<DecisionCategory, string> = {
  INVESTIGATE: "Investigate",
  REQUEST_EVIDENCE: "Request evidence",
  MONITOR: "Monitor",
  ESCALATE: "Escalate",
};

export const LEAD_STATUSES = [
  "new",
  "needs_clarification",
  "snapshot_sent",
  "pilot_requested",
  "not_qualified",
  "follow_up_later",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** External processors that may receive a minimized evidence packet, each behind its own consent. */
export const CONSENT_PROVIDERS = ["typesafe", "openai"] as const;
export type ConsentProvider = (typeof CONSENT_PROVIDERS)[number];

export const SOURCE_FILE_STATUSES = [
  "uploaded",
  "validating",
  "rejected",
  "accepted",
  "processed",
  "failed",
] as const;
export type SourceFileStatus = (typeof SOURCE_FILE_STATUSES)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const SNAPSHOT_RUN_STATUSES = [
  "queued",
  "parsing",
  "analyzing",
  "classifying",
  "completed",
  "insufficient_data",
  "failed",
] as const;
export type SnapshotRunStatus = (typeof SNAPSHOT_RUN_STATUSES)[number];

export const AUDIT_ACTOR_TYPES = ["prospect", "admin", "worker", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export * from "./qualification";

/** Upload limits (docs/product-spec.md §6). The server enforces these; the browser only previews them. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Versions that key a snapshot run. The worker defines the same constants; bump them when the parser
 * or the Jev question set changes so re-processing creates a new run instead of reusing an old one.
 */
export const PARSER_VERSION = "ce-csv/1";
export const QUESTION_SET_VERSION = "jev-qs/1";

export const JOB_KINDS = ["snapshot.process", "storage.delete"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
