import { auditEvent, pilotRequest } from "@cca/db";
import { pilotRequestSchema } from "@cca/domain";

import { withTenant } from "@/lib/db";
import { UserFacingError } from "@/lib/errors";
import { log } from "@/lib/log";
import { leadIdForTenant } from "@/lib/request-session";
import { visitorJsonRoute } from "@/lib/route";

export const POST = visitorJsonRoute("pilot_request.create", pilotRequestSchema, async ({ session, body, requestId }) => {
  // A pilot request is a request to be contacted, so it only exists once we have an identity.
  const leadId = await leadIdForTenant(session.tenantId);
  if (!leadId) throw new UserFacingError(409, "Unlock your report first.", "not_unlocked");

  const id = await withTenant(session.tenantId, async (tx) => {
    const [row] = await tx
      .insert(pilotRequest)
      .values({
        tenantId: session.tenantId,
        leadId,
        snapshotRunId: body.snapshotRunId,
        manualReviewOnly: body.manualReviewOnly,
        preferredPrice: body.preferredPrice,
        message: body.message,
      })
      .returning({ id: pilotRequest.id });
    if (!row) throw new Error("pilot request insert returned no row");
    await tx.insert(auditEvent).values({
      tenantId: session.tenantId,
      actorType: "prospect",
      action: body.manualReviewOnly ? "manual_review.requested" : "pilot.requested",
      objectType: "pilot_request",
      objectId: row.id,
    });
    return row.id;
  });
  log.info("pilot_request.created", { requestId, pilotRequestId: id, manualReviewOnly: body.manualReviewOnly });
  return { status: 201, body: { pilotRequestId: id } };
}, { limit: "pilot" });
