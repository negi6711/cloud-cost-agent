import { presignUploadSchema } from "@cca/domain";
import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, newRequestId, readJsonBody } from "@/lib/http";
import { log } from "@/lib/log";
import { visitorSessionFrom } from "@/lib/request-session";
import { guardRequest } from "@/lib/route";
import { presignUpload } from "@/lib/uploads";
import { createVisitorWorkspace, encodeVisitorSession, VISITOR_COOKIE, VISITOR_TTL_SECONDS } from "@/lib/visitor-session";
import { serverEnv } from "@/lib/env";

/**
 * First step of an upload, before we know who the visitor is: create their workspace if this
 * browser has none, and hand back a short-lived, size-bound URL to put the file into private storage.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  const guard = guardRequest(request, "upload", requestId);
  if (guard) return guard;

  const parsed = presignUploadSchema.safeParse(await readJsonBody(request, 8 * 1024));
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error as z.ZodError<Record<string, unknown>>);
    return NextResponse.json({ error: "The request was not valid.", fieldErrors, requestId }, { status: 400 });
  }

  try {
    const existing = visitorSessionFrom(request);
    const tenantId = existing?.tenantId ?? (await createVisitorWorkspace());
    const result = await presignUpload({ tenantId }, parsed.data);

    const response = NextResponse.json(result, { headers: { "x-request-id": requestId } });
    if (!existing) {
      response.cookies.set(VISITOR_COOKIE, encodeVisitorSession(tenantId), {
        httpOnly: true,
        sameSite: "lax",
        secure: serverEnv().NODE_ENV === "production",
        path: "/",
        maxAge: VISITOR_TTL_SECONDS,
      });
      log.info("visitor.workspace_created", { requestId });
    }
    return response;
  } catch (error) {
    log.error("upload.presign_failed", { requestId, error });
    return errorResponse(500, requestId);
  }
}
