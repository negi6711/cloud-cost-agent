import "server-only";

import { createHash } from "node:crypto";

import { auditEvent, sourceFile } from "@cca/db";
import { type CompleteUploadInput, type PresignUploadInput, sanitizeFilename } from "@cca/domain";
import { and, eq, ne, type SQL } from "drizzle-orm";

import { isUniqueViolation, withTenant } from "./db";
import { serverEnv } from "./env";
import { UserFacingError } from "./errors";
import { log } from "./log";
import { signToken, verifyToken } from "./signing";
import { SNIFF_MESSAGES, sniffUpload } from "./sniff";
import type { UploadSession } from "./request-session";
import { keyBelongsToTenant, newUploadKey, type PresignedUpload, storage } from "./storage";

const GRANT_PURPOSE = "upload-grant/v1";
/** Time allowed between presign and complete: the PUT window plus a margin for slow networks. */
const GRANT_EXTRA_SECONDS = 15 * 60;

interface UploadGrant {
  tenantId: string;
  key: string;
  sizeBytes: number;
  filename: string;
}

export interface PresignResult {
  upload: PresignedUpload;
  uploadToken: string;
}

export async function presignUpload(session: UploadSession, input: PresignUploadInput): Promise<PresignResult> {
  const env = serverEnv();
  if (input.sizeBytes > env.UPLOAD_MAX_BYTES) {
    throw new UserFacingError(413, "The file is larger than the upload limit.", "too_large");
  }
  const key = newUploadKey(session.tenantId);
  const upload = await storage().presignUpload(key, input.sizeBytes);
  const uploadToken = signToken<UploadGrant>(
    env.AUTH_SECRET,
    GRANT_PURPOSE,
    {
      tenantId: session.tenantId,
      key,
      sizeBytes: input.sizeBytes,
      filename: sanitizeFilename(input.filename),
    },
    env.SIGNED_URL_TTL_SECONDS + GRANT_EXTRA_SECONDS,
  );
  return { upload, uploadToken };
}

export type CompleteResult =
  | { status: "accepted"; sourceFileId: string; duplicateOf?: undefined }
  | { status: "accepted"; sourceFileId: string; duplicateOf: string }
  | { status: "rejected"; sourceFileId: string; message: string };

/**
 * Verify an uploaded object and record it. Idempotent per (tenant, idempotencyKey): repeating the
 * same call returns the same result. Re-uploading identical bytes for the same lead returns the
 * earlier file instead of creating a second one.
 */
export async function completeUpload(
  session: UploadSession,
  input: CompleteUploadInput,
  requestId: string,
): Promise<CompleteResult> {
  const env = serverEnv();
  const grant = verifyToken<UploadGrant>(env.AUTH_SECRET, GRANT_PURPOSE, input.uploadToken);
  if (!grant || grant.tenantId !== session.tenantId || !keyBelongsToTenant(grant.key, session.tenantId)) {
    throw new UserFacingError(403, "This upload has expired. Please upload the file again.", "bad_grant");
  }

  const replay = await findByIdempotencyKey(session.tenantId, input.idempotencyKey);
  if (replay) return replay;

  const store = storage();
  const info = await store.head(grant.key);
  if (!info) {
    throw new UserFacingError(409, "We did not receive the file. Please upload it again.", "missing_object");
  }
  // The presigned URL signs the size, but verify anyway: storage is not the only line of defense.
  if (info.sizeBytes !== grant.sizeBytes || info.sizeBytes > env.UPLOAD_MAX_BYTES) {
    await store.delete(grant.key);
    throw new UserFacingError(400, "The uploaded file size did not match. Please upload it again.", "size_mismatch");
  }

  const bytes = await store.read(grant.key, env.UPLOAD_MAX_BYTES);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sniff = sniffUpload(bytes);

  try {
    return await recordUpload(session, input, grant, info.sizeBytes, sha256, sniff, requestId);
  } catch (error) {
    // A concurrent or repeated completion of the same upload: return what the winner recorded.
    if (!isUniqueViolation(error)) throw error;
    const winner =
      (await findByIdempotencyKey(session.tenantId, input.idempotencyKey)) ??
      (await findByStorageKey(session.tenantId, grant.key));
    if (!winner) throw error;
    return winner;
  }
}

async function recordUpload(
  session: UploadSession,
  input: CompleteUploadInput,
  grant: UploadGrant,
  sizeBytes: number,
  sha256: string,
  sniff: ReturnType<typeof sniffUpload>,
  requestId: string,
): Promise<CompleteResult> {
  const store = storage();
  return withTenant(session.tenantId, async (tx) => {
    if (sniff.ok) {
      const [dup] = await tx
        .select({ id: sourceFile.id })
        .from(sourceFile)
        .where(and(eq(sourceFile.sha256, sha256), ne(sourceFile.status, "rejected")))
        .limit(1);
      if (dup) {
        // The second copy is discarded. A retry of this same call then finds no object and asks for
        // a re-upload, which lands here again: nothing is ever stored twice.
        await store.delete(grant.key);
        log.info("upload.duplicate", { requestId, sourceFileId: dup.id });
        return { status: "accepted", sourceFileId: dup.id, duplicateOf: dup.id } as const;
      }
    }

    const [row] = await tx
      .insert(sourceFile)
      .values({
        tenantId: session.tenantId,
        storageKey: grant.key,
        originalFilename: grant.filename,
        mimeType: sniff.ok ? sniff.mimeType : "application/octet-stream",
        sizeBytes,
        sha256,
        status: sniff.ok ? "accepted" : "rejected",
        idempotencyKey: input.idempotencyKey,
      })
      .returning({ id: sourceFile.id });
    if (!row) throw new Error("completeUpload: insert returned no row");

    await tx.insert(auditEvent).values({
      tenantId: session.tenantId,
      actorType: "prospect",
      action: sniff.ok ? "upload.accepted" : "upload.rejected",
      objectType: "source_file",
      objectId: row.id,
      metadata: { sizeBytes, ...(sniff.ok ? {} : { reason: sniff.reason }) },
    });

    if (!sniff.ok) {
      return { status: "rejected", sourceFileId: row.id, message: SNIFF_MESSAGES[sniff.reason] } as const;
    }
    return { status: "accepted", sourceFileId: row.id } as const;
  });
}

function findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<CompleteResult | null> {
  return findOne(tenantId, eq(sourceFile.idempotencyKey, idempotencyKey));
}

function findByStorageKey(tenantId: string, storageKey: string): Promise<CompleteResult | null> {
  return findOne(tenantId, eq(sourceFile.storageKey, storageKey));
}

async function findOne(tenantId: string, where: SQL): Promise<CompleteResult | null> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ id: sourceFile.id, status: sourceFile.status }).from(sourceFile).where(where).limit(1),
  );
  if (!row) return null;
  if (row.status === "rejected") {
    return {
      status: "rejected",
      sourceFileId: row.id,
      message: "This file was not accepted. Upload a CSV export from AWS Cost Explorer.",
    };
  }
  return { status: "accepted", sourceFileId: row.id };
}
