import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, newRequestId } from "@/lib/http";
import { log } from "@/lib/log";
import { getSnapshotDetail } from "@/lib/snapshot-detail";
import { tenantForViewer } from "@/lib/snapshots";
import { getViewer } from "@/lib/viewer";

/** Findings for a snapshot. Requires a signed-in viewer who owns the workspace (or an admin). */
export async function GET(_request: Request, ctx: RouteContext<"/api/snapshots/[id]/findings">): Promise<NextResponse> {
  const requestId = newRequestId();
  const { id } = await ctx.params;
  try {
    const viewer = await getViewer(await headers());
    if (!viewer) return errorResponse(401, requestId, "Please sign in.");
    if (!z.uuid().safeParse(id).success) return errorResponse(404, requestId, "Not found.");

    const tenantId = await tenantForViewer(viewer, id);
    const detail = tenantId ? await getSnapshotDetail(tenantId, id) : null;
    if (!detail) return errorResponse(404, requestId, "Not found.");
    return NextResponse.json(
      { snapshotRunId: detail.id, status: detail.status, findings: detail.findings },
      { headers: { "x-request-id": requestId, "cache-control": "no-store" } },
    );
  } catch (error) {
    log.error("snapshot.findings_failed", { requestId, error });
    return errorResponse(500, requestId);
  }
}
