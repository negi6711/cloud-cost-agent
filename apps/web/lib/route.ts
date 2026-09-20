import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { UserFacingError } from "./errors";
import { errorResponse, newRequestId, readJsonBody } from "./http";
import { log } from "./log";
import { isSameOrigin } from "./origin";
import { checkLimit, clientKey, type LimitName } from "./rate-limit";
import { type UploadSession, visitorSessionFrom } from "./request-session";

interface JsonRouteContext<T> {
  request: Request;
  requestId: string;
  body: T;
  session: UploadSession;
}

/**
 * Standard handling for JSON POST routes that act inside the visitor's own workspace: visitor-cookie
 * check, size-capped body, Zod validation, UserFacingError → its status and message, anything else →
 * a generic 500 with details only in the logs.
 */
export function visitorJsonRoute<S extends z.ZodType>(
  name: string,
  schema: S,
  handler: (ctx: JsonRouteContext<z.infer<S>>) => Promise<{ status: number; body: unknown }>,
  options: { limit: LimitName; maxBytes?: number },
) {
  const maxBytes = options.maxBytes ?? 8 * 1024;
  return async function route(request: Request): Promise<NextResponse> {
    const requestId = newRequestId();
    const guard = guardRequest(request, options.limit, requestId);
    if (guard) return guard;
    const session = visitorSessionFrom(request);
    if (!session) {
      return errorResponse(401, requestId, "This upload session has expired. Please upload your file again.");
    }
    const raw = await readJsonBody(request, maxBytes);
    if (raw === undefined) return errorResponse(400, requestId, "The request could not be read.");
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const { fieldErrors } = z.flattenError(parsed.error as z.ZodError<Record<string, unknown>>);
      return NextResponse.json(
        { error: "The request was not valid.", fieldErrors, requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    try {
      const result = await handler({ request, requestId, body: parsed.data, session });
      return NextResponse.json(result.body, { status: result.status, headers: { "x-request-id": requestId } });
    } catch (error) {
      if (error instanceof UserFacingError) {
        log.info(`${name}.refused`, { requestId, code: error.code });
        return errorResponse(error.status, requestId, error.message);
      }
      log.error(`${name}.failed`, { requestId, error });
      return errorResponse(500, requestId);
    }
  };
}

/** Same-origin and rate-limit checks shared by every state-changing route. */
export function guardRequest(request: Request, limit: LimitName, requestId: string): NextResponse | null {
  if (!isSameOrigin(request)) {
    log.warn("request.cross_origin_refused", { requestId });
    return errorResponse(403, requestId, "This request was refused.");
  }
  const result = checkLimit(limit, clientKey(request));
  if (!result.ok) {
    log.warn("request.rate_limited", { requestId, limit });
    const res = errorResponse(429, requestId, "Too many requests. Please wait a few minutes and try again.");
    res.headers.set("retry-after", String(result.retryAfterSeconds));
    return res;
  }
  return null;
}
