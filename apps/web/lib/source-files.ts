import "server-only";

import { auditEvent, job, snapshotRun, sourceFile } from "@cca/db";
import { eq, sql } from "drizzle-orm";

import { withTenant } from "./db";
import { log } from "./log";
import { storage } from "./storage";
import { scheduleKick } from "./worker-kick";

export interface DeleteActor {
  type: "prospect" | "admin";
  id: string | null;
}

export interface DeleteResult {
  deleted: boolean;
  runsDeleted: number;
  objectDeleted: boolean;
}

/**
 * Delete an uploaded file and everything derived from it, in this order:
 *  1. one transaction: the source_file row (cascading to runs, findings, evidence packets, model
 *     calls and consent), any queued jobs for it, and a content-free audit event;
 *  2. the stored object. If that fails, a `storage.delete` job makes the worker retry it.
 * Rows go first so nothing can read the file once the user has asked for deletion.
 * Copies already processed by TypeSafe are outside our control (docs/security.md).
 */
export async function deleteSourceFile(
  tenantId: string,
  sourceFileId: string,
  actor: DeleteActor,
  requestId: string,
): Promise<DeleteResult> {
  const removed = await withTenant(tenantId, async (tx) => {
    const [file] = await tx
      .select({ id: sourceFile.id, storageKey: sourceFile.storageKey, rawDeletedAt: sourceFile.rawDeletedAt })
      .from(sourceFile)
      .where(eq(sourceFile.id, sourceFileId))
      .limit(1);
    if (!file) return null;
    const runs = await tx.select({ id: snapshotRun.id }).from(snapshotRun).where(eq(snapshotRun.sourceFileId, file.id));
    await tx.delete(job).where(sql`${job.payload}->>'sourceFileId' = ${file.id}`);
    await tx.delete(sourceFile).where(eq(sourceFile.id, file.id));
    await tx.insert(auditEvent).values({
      tenantId,
      actorType: actor.type,
      actorId: actor.id,
      action: "source_file.deleted",
      objectType: "source_file",
      objectId: file.id,
      metadata: { runsDeleted: runs.length },
    });
    return { storageKey: file.storageKey, runsDeleted: runs.length, alreadyGone: file.rawDeletedAt !== null };
  });
  if (!removed) return { deleted: false, runsDeleted: 0, objectDeleted: false };

  let objectDeleted = removed.alreadyGone;
  if (!objectDeleted) {
    try {
      await storage().delete(removed.storageKey);
      objectDeleted = true;
    } catch (error) {
      log.warn("source_file.object_delete_deferred", { requestId, sourceFileId, error });
      await withTenant(tenantId, (tx) =>
        tx
          .insert(job)
          .values({
            tenantId,
            kind: "storage.delete",
            idempotencyKey: `storage.delete:${sourceFileId}`,
            payload: { storageKey: removed.storageKey },
          })
          .onConflictDoNothing({ target: job.idempotencyKey }),
      );
      scheduleKick(requestId);  // a cleanup job; nobody is waiting on this response for it
    }
  }
  log.info("source_file.deleted", { requestId, sourceFileId, runsDeleted: removed.runsDeleted, objectDeleted });
  return { deleted: true, runsDeleted: removed.runsDeleted, objectDeleted };
}

/** The source file behind a run, within a tenant (for "delete this snapshot"). */
export async function sourceFileForRun(tenantId: string, runId: string): Promise<string | null> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ id: snapshotRun.sourceFileId }).from(snapshotRun).where(eq(snapshotRun.id, runId)).limit(1),
  );
  return row?.id ?? null;
}
