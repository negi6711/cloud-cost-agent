import { profileSchema } from "@cca/domain";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, newRequestId, readJsonBody } from "@/lib/http";
import { log } from "@/lib/log";
import { saveProfile } from "@/lib/profile";
import { guardRequest } from "@/lib/route";
import { tenantForViewer } from "@/lib/snapshots";
import { getViewer } from "@/lib/viewer";
import { UserFacingError } from "@/lib/errors";

const bodySchema = profileSchema.extend({ snapshotRunId: z.uuid() });

/**
 * The optional qualification answers, submitted from the report page after unlock. Behind the
 * signed-in session, not the visitor cookie: by this point the person has proven their email.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  const guard = guardRequest(request, "lead", requestId);
  if (guard) return guard;

  const viewer = await getViewer(await headers());
  if (!viewer) return errorResponse(401, requestId, "Please sign in again.");

  const parsed = bodySchema.safeParse(await readJsonBody(request, 8 * 1024));
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error as z.ZodError<Record<string, unknown>>);
    return NextResponse.json(
      { error: "Please check the highlighted fields.", fieldErrors, requestId },
      { status: 400, headers: { "x-request-id": requestId } },
    );
  }

  const { snapshotRunId, ...profile } = parsed.data;
  // Admins are excluded: this writes the prospect's own answers, never on their behalf.
  const tenantId = viewer.isAdmin ? null : await tenantForViewer(viewer, snapshotRunId);
  if (!tenantId) return errorResponse(404, requestId, "Not found.");

  try {
    await saveProfile(tenantId, profile);
    log.info("lead.profile_updated", { requestId });
    return NextResponse.json({ ok: true }, { status: 200, headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof UserFacingError) return errorResponse(error.status, requestId, error.message);
    log.error("lead.profile_failed", { requestId, error });
    return errorResponse(500, requestId);
  }
}
