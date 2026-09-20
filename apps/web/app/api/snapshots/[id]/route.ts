import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, newRequestId } from "@/lib/http";
import { log } from "@/lib/log";
import { visitorSessionFrom } from "@/lib/request-session";
import { getSnapshotStatus } from "@/lib/snapshots";

/**
 * Processing status and the teaser headline for the upload page. Deliberately no finding text,
 * owner or next action: those are the report, and the report needs a verified email.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/snapshots/[id]">): Promise<NextResponse> {
  const requestId = newRequestId();
  const session = visitorSessionFrom(request);
  if (!session) return errorResponse(401, requestId, "This upload session has expired. Please upload your file again.");

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return errorResponse(404, requestId, "Not found.");

  try {
    const status = await getSnapshotStatus(session.tenantId, id);
    if (!status) return errorResponse(404, requestId, "Not found.");
    return NextResponse.json(status, {
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    });
  } catch (error) {
    log.error("snapshot.status_failed", { requestId, error });
    return errorResponse(500, requestId);
  }
}
