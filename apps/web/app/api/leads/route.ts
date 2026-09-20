import { unlockSchema } from "@cca/domain";
import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, newRequestId, readJsonBody } from "@/lib/http";
import { log } from "@/lib/log";
import { visitorSessionFrom } from "@/lib/request-session";
import { guardRequest } from "@/lib/route";
import { unlockReport } from "@/lib/unlock";
import { UserFacingError } from "@/lib/errors";

const MAX_BODY_BYTES = 16 * 1024;

/**
 * The email gate. The visitor has already seen the deterministic teaser for their own upload; this
 * records who they are and what they consented to, then starts the classification phase and emails
 * a one-time link to the report.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  const guard = guardRequest(request, "lead", requestId);
  if (guard) return guard;

  const session = visitorSessionFrom(request);
  if (!session) {
    return errorResponse(401, requestId, "This upload session has expired. Please upload your file again.");
  }

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (body === undefined) {
    return errorResponse(400, requestId, "The form could not be read. Please try again.");
  }

  const parsed = unlockSchema.safeParse(body);
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error as z.ZodError<Record<string, unknown>>);
    // The honeypot gets the same generic answer as any other invalid form.
    if (fieldErrors.faxNumber) {
      log.warn("lead.honeypot", { requestId });
      return errorResponse(400, requestId, "Please check the form and try again.");
    }
    return NextResponse.json(
      { error: "Please check the highlighted fields.", fieldErrors, requestId },
      { status: 400, headers: { "x-request-id": requestId } },
    );
  }

  try {
    const result = await unlockReport(session.tenantId, parsed.data, requestId);
    return NextResponse.json(
      {
        snapshotRunId: result.snapshotRunId,
        classificationQueued: result.classificationQueued,
        // The report itself is behind the emailed link: the address has to be proven first.
        message: "Check your email for a one-time link to your report.",
      },
      { status: 201, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    if (error instanceof UserFacingError) {
      log.info("lead.unlock_refused", { requestId, code: error.code });
      return errorResponse(error.status, requestId, error.message);
    }
    log.error("lead.unlock_failed", { requestId, error });
    return errorResponse(500, requestId);
  }
}
