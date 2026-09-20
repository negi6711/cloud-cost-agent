import "server-only";

import { PARSER_VERSION, QUESTION_SET_VERSION, type SnapshotRunStatus } from "@cca/config";
import { auditEvent, job, lead, snapshotRun, sourceFile } from "@cca/db";
import type { CreateSnapshotInput } from "@cca/domain";
import { and, eq, isNull, sql } from "drizzle-orm";

import { withAdmin, withTenant } from "./db";
import { UserFacingError } from "./errors";

export interface CreatedSnapshot {
  snapshotRunId: string;
  created: boolean;
}

/**
 * Create the snapshot run for an accepted file and enqueue its processing job, in one transaction.
 * Idempotent: a run is unique per (file, parser version, question-set version) and its job per run,
 * so repeated or concurrent calls return the same run and never enqueue twice.
 */
export async function createSnapshot(tenantId: string, input: CreateSnapshotInput): Promise<CreatedSnapshot> {
  return withTenant(tenantId, async (tx) => {
    const [file] = await tx
      .select({ id: sourceFile.id, status: sourceFile.status })
      .from(sourceFile)
      .where(eq(sourceFile.id, input.sourceFileId))
      .limit(1);
    // Another tenant's file is invisible under RLS, so it reads as "not found".
    if (!file) throw new UserFacingError(404, "We could not find that upload.", "not_found");
    if (file.status === "rejected") {
      throw new UserFacingError(409, "This file was not accepted, so it cannot be analyzed.", "rejected_file");
    }

    // Uploads happen before the email gate, so a new run is always the free deterministic phase.
    // "pending" keeps every model provider unavailable until the report is unlocked.
    const consentBasis = "pending";

    const inserted = await tx
      .insert(snapshotRun)
      .values({
        tenantId,
        sourceFileId: file.id,
        parserVersion: PARSER_VERSION,
        questionSetVersion: QUESTION_SET_VERSION,
        status: "queued",
        consentBasis,
      })
      .onConflictDoNothing({
        target: [snapshotRun.tenantId, snapshotRun.sourceFileId, snapshotRun.parserVersion, snapshotRun.questionSetVersion],
      })
      .returning({ id: snapshotRun.id });

    const created = inserted.length > 0;
    const runId =
      inserted[0]?.id ??
      (
        await tx
          .select({ id: snapshotRun.id })
          .from(snapshotRun)
          .where(
            and(
              eq(snapshotRun.sourceFileId, file.id),
              eq(snapshotRun.parserVersion, PARSER_VERSION),
              eq(snapshotRun.questionSetVersion, QUESTION_SET_VERSION),
            ),
          )
          .limit(1)
      )[0]?.id;
    if (!runId) throw new Error("createSnapshot: run neither inserted nor found");

    if (created) {
      await tx
        .insert(job)
        .values({
          tenantId,
          kind: "snapshot.process",
          idempotencyKey: `snapshot.process:${runId}`,
          payload: { snapshotRunId: runId, sourceFileId: file.id },
        })
        .onConflictDoNothing({ target: job.idempotencyKey });
      await tx.insert(auditEvent).values({
        tenantId,
        actorType: "prospect",
        action: "snapshot.requested",
        objectType: "snapshot_run",
        objectId: runId,
        metadata: { consentBasis, clientIdempotencyKey: input.idempotencyKey },
      });
    }
    return { snapshotRunId: runId, created };
  });
}

/**
 * Status and teaser for the upload page, before any email is given. Headline numbers only: no
 * finding text, no owner, no next action, no model output. The full report needs a verified email.
 */
export interface SnapshotStatus {
  id: string;
  status: SnapshotRunStatus;
  rowsSeen: number | null;
  rowsAccepted: number | null;
  rowsRejected: number | null;
  warningCount: number;
  completed: boolean;
  /** For a failed run: the worker's user-facing reason (our wording, never file contents). */
  message: string | null;
  unlocked: boolean;
  teaser: Teaser | null;
}

export interface Teaser {
  currency: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  totalCovered: string;
  baselineMonth: string | null;
  currentMonth: string | null;
  /** Whole-bill change between the two compared months. */
  change: string | null;
  changePct: string | null;
  /** Largest single driver of the increase. */
  topDriver: { label: string; change: string } | null;
  /**
   * Sum of the material increases found. This is money that MOVED, not money anyone can recover:
   * the copy must call it "cost impact requiring investigation", never savings.
   */
  investigationImpact: string;
  findingCount: number;
  readinessScore: number | null;
}

interface StoredIssue {
  severity?: string;
  message?: string;
}

function firstErrorMessage(warnings: unknown): string | null {
  if (!Array.isArray(warnings)) return null;
  const error = (warnings as StoredIssue[]).find((w) => w?.severity === "error" && typeof w.message === "string");
  return error?.message ?? null;
}

export async function getSnapshotStatus(tenantId: string, runId: string): Promise<SnapshotStatus | null> {
  const [run] = await withTenant(tenantId, (tx) =>
    tx
      .select({
        id: snapshotRun.id,
        status: snapshotRun.status,
        rowsSeen: snapshotRun.rowsSeen,
        rowsAccepted: snapshotRun.rowsAccepted,
        rowsRejected: snapshotRun.rowsRejected,
        warnings: snapshotRun.warnings,
        completedAt: snapshotRun.completedAt,
        unlockedAt: snapshotRun.unlockedAt,
        summary: snapshotRun.summary,
        findings: sql<number>`(select count(*)::int from snapshot_finding f where f.snapshot_run_id = ${snapshotRun.id})`,
      })
      .from(snapshotRun)
      .where(eq(snapshotRun.id, runId))
      .limit(1),
  );
  if (!run) return null;
  return {
    unlocked: run.unlockedAt !== null,
    teaser: run.status === "completed" ? buildTeaser(run.summary, run.findings) : null,
    id: run.id,
    status: run.status as SnapshotRunStatus,
    rowsSeen: run.rowsSeen,
    rowsAccepted: run.rowsAccepted,
    rowsRejected: run.rowsRejected,
    warningCount: Array.isArray(run.warnings) ? run.warnings.length : 0,
    completed: run.completedAt !== null,
    message: run.status === "failed" || run.status === "insufficient_data" ? firstErrorMessage(run.warnings) : null,
  };
}

export interface SnapshotSummary {
  id: string;
  status: SnapshotRunStatus;
  createdAt: Date;
  filename: string;
}

/** Runs across the given workspaces, newest first. Each tenant is read under its own RLS context. */
export async function listSnapshots(tenantIds: string[]): Promise<SnapshotSummary[]> {
  const all = await Promise.all(
    tenantIds.map((tenantId) =>
      withTenant(tenantId, (tx) =>
        tx
          .select({
            id: snapshotRun.id,
            status: snapshotRun.status,
            createdAt: snapshotRun.createdAt,
            filename: sourceFile.originalFilename,
          })
          .from(snapshotRun)
          .innerJoin(
            sourceFile,
            and(eq(sourceFile.tenantId, snapshotRun.tenantId), eq(sourceFile.id, snapshotRun.sourceFileId)),
          ),
      ),
    ),
  );
  return all
    .flat()
    .map((r) => ({ ...r, status: r.status as SnapshotRunStatus }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Find a run the viewer may see: in one of their workspaces. Returns null otherwise. */
export async function findViewableSnapshot(
  tenantIds: string[],
  runId: string,
): Promise<{ tenantId: string; status: SnapshotStatus } | null> {
  for (const tenantId of tenantIds) {
    const status = await getSnapshotStatus(tenantId, runId);
    if (status) return { tenantId, status };
  }
  return null;
}

/** Admin only (caller must have checked): the tenant that owns a run, across all workspaces. */
export async function snapshotTenantForAdmin(runId: string): Promise<string | null> {
  const [row] = await withAdmin((tx) =>
    tx.select({ tenantId: snapshotRun.tenantId }).from(snapshotRun).where(eq(snapshotRun.id, runId)).limit(1),
  );
  return row?.tenantId ?? null;
}

/**
 * The workspace in which this viewer may see the run: one of their own, or any for an admin.
 * Returns null otherwise, so another workspace's run is indistinguishable from a missing one.
 */
export async function tenantForViewer(
  viewer: { tenantIds: string[]; isAdmin: boolean },
  runId: string,
): Promise<string | null> {
  const own = await findViewableSnapshot(viewer.tenantIds, runId);
  if (own) return own.tenantId;
  return viewer.isAdmin ? snapshotTenantForAdmin(runId) : null;
}

/** Headline numbers only, projected from the run summary the worker wrote. */
function buildTeaser(summary: unknown, findingCount: number): Teaser | null {
  if (!summary || typeof summary !== "object") return null;
  const s = summary as SnapshotSummaryShape;
  // Prefer the primary dimension (usually service): a region or account row would name the same
  // money a second time, and "ECS" is a more useful headline than "us-east-1".
  const changes = s.largest_changes ?? {};
  const drivers = (s.dimension && changes[s.dimension]) || Object.values(changes).flat();
  const top = drivers.filter((d) => Number(d.delta) > 0).sort((a, b) => Number(b.delta) - Number(a.delta))[0];
  return {
    currency: s.currency ?? null,
    periodStart: s.period?.start ?? null,
    periodEnd: s.period?.end ?? null,
    totalCovered: s.total ?? "0",
    baselineMonth: s.comparison?.baseline_month ?? null,
    currentMonth: s.comparison?.current_month ?? null,
    change: s.comparison?.delta ?? null,
    changePct: s.comparison?.delta_pct ?? null,
    topDriver: top ? { label: top.label, change: top.delta } : null,
    investigationImpact: s.investigation_impact ?? "0",
    findingCount,
    readinessScore: s.readiness?.score ?? null,
  };
}

interface SnapshotSummaryShape {
  currency?: string | null;
  dimension?: string;
  period?: { start: string | null; end: string | null };
  total?: string;
  comparison?: { baseline_month: string; current_month: string; delta: string; delta_pct: string | null } | null;
  largest_changes?: Record<string, { label: string; delta: string }[]>;
  investigation_impact?: string;
  readiness?: { score: number };
}

/**
 * Record that the report was opened by the person it was unlocked for. Reaching the report page
 * means the emailed one-time link was used, which is what proves the address belongs to them, so
 * both stamps are written here. First write wins: these mark "when did this first happen".
 */
export async function markReportViewed(tenantId: string, runId: string, email: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(snapshotRun)
      .set({ viewedAt: new Date() })
      .where(and(eq(snapshotRun.id, runId), isNull(snapshotRun.viewedAt)));
    await tx
      .update(lead)
      .set({ emailVerifiedAt: new Date() })
      .where(and(eq(lead.email, email), isNull(lead.emailVerifiedAt)));
  });
}
