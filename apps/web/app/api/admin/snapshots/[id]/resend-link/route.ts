import { z } from "zod";

import { resendResultLink } from "@/lib/admin";
import { adminJsonRoute } from "@/lib/admin-route";

export const POST = adminJsonRoute("admin.resend_link", z.object({}), async ({ id, adminEmail }) => {
  await resendResultLink(id, adminEmail);
  return { status: 200, body: { sent: true } };
});
