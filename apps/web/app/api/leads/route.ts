import { leadInputSchema } from "@cca/domain";
import { NextResponse } from "next/server";
import { z } from "zod";

import { serverEnv } from "@/lib/env";
import { errorResponse, newRequestId, readJsonBody } from "@/lib/http";
import { encodeLeadSession, LEAD_SESSION_COOKIE, LEAD_SESSION_TTL_SECONDS } from "@/lib/lead-session";
import { createLead } from "@/lib/leads";
import { log } from "@/lib/log";

const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (body === undefined) {
    return errorResponse(400, requestId, "The form could not be read. Please try again.");
  }

  const parsed = leadInputSchema.safeParse(body);
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
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
    const { leadId, tenantId } = await createLead(parsed.data);
    log.info("lead.created", { requestId, leadId, spendBand: parsed.data.spendBand });

    const response = NextResponse.json(
      { leadId },
      { status: 201, headers: { "x-request-id": requestId } },
    );
    response.cookies.set(LEAD_SESSION_COOKIE, encodeLeadSession({ leadId, tenantId }), {
      httpOnly: true,
      sameSite: "lax",
      secure: serverEnv().NODE_ENV === "production",
      path: "/",
      maxAge: LEAD_SESSION_TTL_SECONDS,
    });
    return response;
  } catch (error) {
    log.error("lead.create_failed", { requestId, error });
    return errorResponse(500, requestId);
  }
}
