import "server-only";

import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { UserFacingError } from "./errors";
import { errorResponse, newRequestId, readJsonBody } from "./http";
import { log } from "./log";
import { guardRequest } from "./route";
import { getViewer } from "./viewer";

interface AdminContext<T> {
  id: string;
  body: T;
  adminEmail: string;
  requestId: string;
}

/**
 * Admin JSON routes: same-origin and rate-limit guard, a signed-in admin (401 signed out, 403
 * otherwise), a UUID path id, a validated body. Only then does the handler run.
 */
export function adminJsonRoute<S extends z.ZodType, P extends string>(
  name: string,
  schema: S,
  handler: (ctx: AdminContext<z.infer<S>>) => Promise<{ status: number; body: unknown }>,
) {
  return async function route(request: Request, ctx: { params: Promise<Record<P, string>> }): Promise<NextResponse> {
    const requestId = newRequestId();
    const guard = guardRequest(request, "admin", requestId);
    if (guard) return guard;
    const viewer = await getViewer(await headers());
    if (!viewer) return errorResponse(401, requestId, "Please sign in.");
    if (!viewer.isAdmin) {
      log.warn(`${name}.not_admin`, { requestId });
      return errorResponse(403, requestId, "Not allowed.");
    }
    const params = (await ctx.params) as Record<string, string>;
    const id = params.id ?? "";
    if (!z.uuid().safeParse(id).success) return errorResponse(404, requestId, "Not found.");
    const raw = await readJsonBody(request, 8 * 1024);
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      const { fieldErrors } = z.flattenError(parsed.error as z.ZodError<Record<string, unknown>>);
      return NextResponse.json({ error: "The request was not valid.", fieldErrors, requestId }, { status: 400 });
    }
    try {
      const result = await handler({ id, body: parsed.data, adminEmail: viewer.email, requestId });
      return NextResponse.json(result.body, { status: result.status, headers: { "x-request-id": requestId } });
    } catch (error) {
      if (error instanceof UserFacingError) return errorResponse(error.status, requestId, error.message);
      log.error(`${name}.failed`, { requestId, error });
      return errorResponse(500, requestId);
    }
  };
}
