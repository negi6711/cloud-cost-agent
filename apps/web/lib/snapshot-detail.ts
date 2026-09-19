import "server-only";

import type { DecisionCategory, SnapshotRunStatus } from "@cca/config";
import { snapshotFinding, snapshotRun, sourceFile } from "@cca/db";
import { and, asc, eq } from "drizzle-orm";

import { withTenant } from "./db";

export interface Statement {
  text: string;
  refs: string[];
}

export interface MissingItem {
  code: string;
  label: string;
}

export interface FindingView {
  evidenceId: string;
  rank: number;
  kind: string;
  severity: string;
  title: string;
  whatChanged: string;
  whatWeKnow: Statement[];
  missing: MissingItem[];
  nextAction: string;
  finalCategory: DecisionCategory;
  observed: string | null;
  baseline: string | null;
  delta: string | null;
  /** Model suggestion (null when classification did not run). */
  model: {
    category: DecisionCategory;
    confidence: number | null;
    ownerLabel: string | null;
    urgency: string | null;
    risk: string | null;
  } | null;
  modelStatus: string;
  policyStatus: string;
  policyReasons: string[];
  reviewRequired: boolean;
  explanationSource: string;
}

export interface SnapshotDetail {
  id: string;
  status: SnapshotRunStatus;
  filename: string;
  completedAt: Date | null;
  readinessScore: number | null;
  modelStatus: string | null;
  modelProvider: string | null;
  modelIdentifier: string | null;
  consentBasis: string | null;
  explanationProvider: string | null;
  rows: { seen: number | null; accepted: number | null; rejected: number | null };
  summary: SnapshotSummaryJson | null;
  issues: { code: string; severity: string; message: string; count?: number }[];
  findings: FindingView[];
}

/** Shape written by worker/src/cca/snapshots/analyze.py `_summary` (version 1). */
export interface SnapshotSummaryJson {
  version: number;
  period: { start: string | null; end: string | null };
  currency: string | null;
  dimension_label: string;
  total: string;
  months: { month: string; total: string; complete: boolean }[];
  comparison: {
    baseline_month: string;
    current_month: string;
    baseline_total: string;
    current_total: string;
    delta: string;
    delta_pct: string | null;
  } | null;
  top_items: { label: string; cost: string; share: string }[];
  data_gaps: { code: string; message: string }[];
  readiness: { score: number; components: Record<string, number> };
  thresholds: { material_absolute: string; provisional: boolean };
}

/** Everything the snapshot page shows, read under the tenant's RLS context. */
export async function getSnapshotDetail(tenantId: string, runId: string): Promise<SnapshotDetail | null> {
  return withTenant(tenantId, async (tx) => {
    const [run] = await tx
      .select({
        id: snapshotRun.id,
        status: snapshotRun.status,
        filename: sourceFile.originalFilename,
        completedAt: snapshotRun.completedAt,
        readinessScore: snapshotRun.dataReadinessScore,
        modelStatus: snapshotRun.modelStatus,
        modelProvider: snapshotRun.modelProvider,
        modelIdentifier: snapshotRun.modelIdentifier,
        consentBasis: snapshotRun.consentBasis,
        explanationProvider: snapshotRun.explanationProvider,
        rowsSeen: snapshotRun.rowsSeen,
        rowsAccepted: snapshotRun.rowsAccepted,
        rowsRejected: snapshotRun.rowsRejected,
        summary: snapshotRun.summary,
        warnings: snapshotRun.warnings,
      })
      .from(snapshotRun)
      .innerJoin(sourceFile, and(eq(sourceFile.tenantId, snapshotRun.tenantId), eq(sourceFile.id, snapshotRun.sourceFileId)))
      .where(eq(snapshotRun.id, runId))
      .limit(1);
    if (!run) return null;

    const rows = await tx
      .select()
      .from(snapshotFinding)
      .where(eq(snapshotFinding.snapshotRunId, runId))
      .orderBy(asc(snapshotFinding.rank));

    return {
      id: run.id,
      status: run.status as SnapshotRunStatus,
      filename: run.filename,
      completedAt: run.completedAt,
      readinessScore: run.readinessScore === null ? null : Number(run.readinessScore),
      modelStatus: run.modelStatus,
      modelProvider: run.modelProvider,
      modelIdentifier: run.modelIdentifier,
      consentBasis: run.consentBasis,
      explanationProvider: run.explanationProvider,
      rows: { seen: run.rowsSeen, accepted: run.rowsAccepted, rejected: run.rowsRejected },
      summary: (run.summary as SnapshotSummaryJson | null) ?? null,
      issues: Array.isArray(run.warnings) ? (run.warnings as SnapshotDetail["issues"]) : [],
      findings: rows.map((f) => ({
        evidenceId: f.evidenceId,
        rank: f.rank,
        kind: f.kind,
        severity: f.severity,
        title: f.title,
        whatChanged: f.explanation,
        whatWeKnow: (f.evidence as Statement[]) ?? [],
        missing: (f.missingEvidence as MissingItem[]) ?? [],
        nextAction: f.nextAction,
        finalCategory: f.finalCategory as DecisionCategory,
        observed: f.observedValue,
        baseline: f.baselineValue,
        delta: f.deltaValue,
        model: f.jevCategory
          ? {
              category: f.jevCategory as DecisionCategory,
              confidence: f.jevConfidence === null ? null : Number(f.jevConfidence),
              ownerLabel: f.owner,
              urgency: f.jevUrgency,
              risk: f.jevRisk,
            }
          : null,
        modelStatus: f.modelStatus,
        policyStatus: f.policyStatus,
        policyReasons: (f.policyReasons as string[]) ?? [],
        reviewRequired: f.reviewRequired,
        explanationSource: f.explanationSource,
      })),
    };
  });
}
