import "server-only";

import { PARSER_VERSION, QUESTION_SET_VERSION, type SnapshotRunStatus } from "@cca/config";
import { auditEvent, consent, job, snapshotRun, sourceFile } from "@cca/db";
import type { CreateSnapshotInput } from "@cca/domain";
import { and, desc, eq } from "drizzle-orm";

import { withTenant } from "./db";
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

    const [latestConsent] = await tx
      .select({ granted: consent.granted })
      .from(consent)
      .where(and(eq(consent.sourceFileId, file.id), eq(consent.provider, "typesafe")))
      .orderBy(desc(consent.createdAt))
      .limit(1);
    const consentBasis = latestConsent?.granted ? "typesafe:granted" : "typesafe:declined";

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

/** Status shown on the upload page. Deliberately no findings: those require login. */
export interface SnapshotStatus {
  id: string;
  status: SnapshotRunStatus;
  rowsSeen: number | null;
  rowsAccepted: number | null;
  rowsRejected: number | null;
  warningCount: number;
  completed: boolean;
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
      })
      .from(snapshotRun)
      .where(eq(snapshotRun.id, runId))
      .limit(1),
  );
  if (!run) return null;
  return {
    id: run.id,
    status: run.status as SnapshotRunStatus,
    rowsSeen: run.rowsSeen,
    rowsAccepted: run.rowsAccepted,
    rowsRejected: run.rowsRejected,
    warningCount: Array.isArray(run.warnings) ? run.warnings.length : 0,
    completed: run.completedAt !== null,
  };
}
