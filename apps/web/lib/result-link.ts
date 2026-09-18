import "server-only";

import { lead } from "@cca/db";
import { eq } from "drizzle-orm";

import { getAuth } from "./auth";
import { withTenant } from "./db";
import { log } from "./log";

/**
 * Email the lead a one-time sign-in link that lands on their snapshot. Results are never shown
 * without this login. Best effort: a failed send is logged and the lead can request a new link
 * from /login.
 */
export async function sendResultLink(tenantId: string, leadId: string, snapshotRunId: string, requestId: string): Promise<void> {
  try {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select({ email: lead.email }).from(lead).where(eq(lead.id, leadId)).limit(1),
    );
    if (!row) return;
    await getAuth().api.signInMagicLink({
      body: { email: row.email, callbackURL: `/snapshot/${snapshotRunId}` },
      headers: new Headers(),
    });
    log.info("snapshot.result_link_sent", { requestId, snapshotRunId });
  } catch (error) {
    log.error("snapshot.result_link_failed", { requestId, snapshotRunId, error });
  }
}
