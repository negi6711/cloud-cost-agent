import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { NextResponse } from "next/server";

import { errorResponse, newRequestId } from "@/lib/http";
import { log } from "@/lib/log";
import { localStorageOrNull } from "@/lib/storage";

/**
 * Receives presigned uploads for the local storage driver, mimicking an R2 presigned PUT: the token
 * binds key, exact size and expiry. Returns 404 whenever hosted storage is configured.
 */
export async function PUT(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  const local = localStorageOrNull();
  if (!local) return errorResponse(404, requestId, "Not found.");

  const grant = local.verifyPutToken(new URL(request.url).searchParams.get("token"));
  if (!grant) return errorResponse(403, requestId, "This upload link is invalid or has expired.");

  const declared = Number(request.headers.get("content-length"));
  if (declared !== grant.contentLength || !request.body) {
    return errorResponse(400, requestId, "The file size did not match the upload request.");
  }

  const finalPath = await local.ensureParent(grant.key);
  const partPath = `${finalPath}.part-${requestId}`;
  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length;
      if (received > grant.contentLength) done(new Error("size exceeded"));
      else done(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(request.body as import("node:stream/web").ReadableStream<Uint8Array>),
      limit,
      createWriteStream(partPath, { flags: "wx" }),
    );
    if (received !== grant.contentLength) throw new Error("size mismatch");
    await rename(partPath, finalPath);
  } catch (error) {
    await rm(partPath, { force: true });
    log.warn("dev_storage.upload_rejected", { requestId, error });
    return errorResponse(400, requestId, "The file size did not match the upload request.");
  }

  return new NextResponse(null, { status: 200, headers: { "x-request-id": requestId } });
}
