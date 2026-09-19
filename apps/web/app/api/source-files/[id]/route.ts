import { sourceFile } from "@cca/db";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { withAdmin } from "@/lib/db";
import { errorResponse, newRequestId } from "@/lib/http";
import { log } from "@/lib/log";
import { guardRequest } from "@/lib/route";
import { deleteSourceFile } from "@/lib/source-files";
import { getViewer } from "@/lib/viewer";

/**
 * Delete an uploaded file and all derived data. The signed-in prospect may delete files in their
 * own workspaces; an admin may delete any. Other workspaces' files read as "not found".
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/source-files/[id]">): Promise<NextResponse> {
  const requestId = newRequestId();
  const guard = guardRequest(request, "delete", requestId);
  if (guard) return guard;
  const { id } = await ctx.params;
  try {
    const viewer = await getViewer(await headers());
    if (!viewer) return errorResponse(401, requestId, "Please sign in.");
    if (!z.uuid().safeParse(id).success) return errorResponse(404, requestId, "Not found.");

    for (const tenantId of viewer.tenantIds) {
      const result = await deleteSourceFile(tenantId, id, { type: "prospect", id: null }, requestId);
      if (result.deleted) return NextResponse.json(result, { headers: { "x-request-id": requestId } });
    }
    if (viewer.isAdmin) {
      const [row] = await withAdmin((tx) =>
        tx.select({ tenantId: sourceFile.tenantId }).from(sourceFile).where(eq(sourceFile.id, id)).limit(1),
      );
      if (row) {
        const result = await deleteSourceFile(row.tenantId, id, { type: "admin", id: viewer.email }, requestId);
        return NextResponse.json(result, { headers: { "x-request-id": requestId } });
      }
    }
    return errorResponse(404, requestId, "Not found.");
  } catch (error) {
    log.error("source_file.delete_failed", { requestId, error });
    return errorResponse(500, requestId);
  }
}
