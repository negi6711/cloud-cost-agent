import { adminLeadStatusSchema } from "@cca/domain";

import { setLeadStatus } from "@/lib/admin";
import { adminJsonRoute } from "@/lib/admin-route";

export const POST = adminJsonRoute("admin.lead_status", adminLeadStatusSchema, async ({ id, body, adminEmail }) => {
  await setLeadStatus(id, body.status, adminEmail);
  return { status: 200, body: { leadId: id, status: body.status } };
});
