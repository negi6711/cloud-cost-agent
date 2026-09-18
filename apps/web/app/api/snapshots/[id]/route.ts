import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, newRequestId } from "@/lib/http";
import { log } from "@/lib/log";
import { leadSessionFrom } from "@/lib/request-session";
import { getSnapshotStatus } from "@/lib/snapshots";

/**
 * Processing status for the upload page. Returns no findings: those are shown only after the
 * prospect signs in with the emailed link.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/snapshots/[id]">): Promise<NextResponse> {
  const requestId = newRequestId();
  const session = leadSessionFrom(request);
  if (!session) return errorResponse(401, requestId, "Your session has expired.");

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
