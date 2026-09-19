import { auditEvent, pilotRequest } from "@cca/db";
import { pilotRequestSchema } from "@cca/domain";

import { withTenant } from "@/lib/db";
import { log } from "@/lib/log";
import { leadJsonRoute } from "@/lib/route";

export const POST = leadJsonRoute("pilot_request.create", pilotRequestSchema, async ({ session, body, requestId }) => {
  const id = await withTenant(session.tenantId, async (tx) => {
    const [row] = await tx
      .insert(pilotRequest)
      .values({
        tenantId: session.tenantId,
        leadId: session.leadId,
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
