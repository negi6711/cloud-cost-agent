import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { UserFacingError } from "./errors";
import { errorResponse, newRequestId, readJsonBody } from "./http";
import type { LeadSession } from "./lead-session";
import { log } from "./log";
import { leadSessionFrom } from "./request-session";

interface JsonRouteContext<T> {
  request: Request;
  requestId: string;
  body: T;
  session: LeadSession;
}

/**
 * Standard handling for JSON POST routes that act for the lead who just filled the form:
 * lead-session check, size-capped body, Zod validation, UserFacingError → its status and message,
 * anything else → generic 500 with details only in the logs.
 */
export function leadJsonRoute<S extends z.ZodType>(
  name: string,
  schema: S,
  handler: (ctx: JsonRouteContext<z.infer<S>>) => Promise<{ status: number; body: unknown }>,
  maxBytes = 8 * 1024,
) {
  return async function route(request: Request): Promise<NextResponse> {
    const requestId = newRequestId();
    const session = leadSessionFrom(request);
    if (!session) {
      return errorResponse(401, requestId, "Your session has expired. Please fill in the form again.");
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
