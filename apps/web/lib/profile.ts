import "server-only";

import { auditEvent, lead } from "@cca/db";
import type { ProfileInput } from "@cca/domain";
import { eq } from "drizzle-orm";

import { withTenant } from "./db";
import { UserFacingError } from "./errors";

/**
 * The qualification answers, asked after the report is unlocked rather than in front of it. Every
 * field is optional and each one only overwrites the placeholder written at unlock, so a half-filled
 * form never erases what the person already told us.
 */
export async function saveProfile(tenantId: string, input: ProfileInput): Promise<void> {
  const patch = {
    ...(input.country ? { country: input.country } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.spendBand ? { spendBand: input.spendBand } : {}),
    ...(input.biggestProblem ? { biggestProblem: input.biggestProblem } : {}),
    ...(input.contactPermission === undefined ? {} : { contactPermission: input.contactPermission }),
  };
  if (Object.keys(patch).length === 0) return;

  await withTenant(tenantId, async (tx) => {
    const [row] = await tx.select({ id: lead.id }).from(lead).limit(1);
    if (!row) throw new UserFacingError(409, "Unlock your report first.", "not_unlocked");
    await tx.update(lead).set({ ...patch, updatedAt: new Date() }).where(eq(lead.id, row.id));
    await tx.insert(auditEvent).values({
      tenantId,
      actorType: "prospect",
      action: "lead.profile_updated",
      objectType: "lead",
      objectId: row.id,
      metadata: { fields: Object.keys(patch) },
    });
  });
}

/**
 * Whether it is still worth asking. True while the lead holds the placeholders written at unlock,
 * so the form disappears once the person has answered.
 */
export async function profileIncomplete(tenantId: string): Promise<boolean> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ biggestProblem: lead.biggestProblem, country: lead.country }).from(lead).limit(1),
  );
  if (!row) return false;
  return row.biggestProblem.trim() === "" || row.country === "OTHER";
}
