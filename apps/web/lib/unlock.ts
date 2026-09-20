import "server-only";

import { auditEvent, consent, job, lead, snapshotRun, sourceFile, tenant } from "@cca/db";
import { CONTACT_BASIS, TYPESAFE_DISCLOSURE_VERSION, type UnlockInput } from "@cca/domain";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { getAuth } from "./auth";
import { withTenant } from "./db";
import { UserFacingError } from "./errors";
import { log } from "./log";
import { kickWorker } from "./worker-kick";

export interface UnlockResult {
  leadId: string;
  snapshotRunId: string | null;
  classificationQueued: boolean;
}

/**
 * The email gate. The visitor has already seen the deterministic teaser for a file in their own
 * workspace; this attaches their identity to it, records consent, and starts the classification
 * phase. Jev cannot have run before this point: the run's consent was "pending", and that provider
 * is always unavailable.
 */
export async function unlockReport(tenantId: string, input: UnlockInput, requestId: string): Promise<UnlockResult> {
  const consentBasis = input.typesafeConsent ? "typesafe:granted" : "typesafe:declined";

  const result = await withTenant(tenantId, async (tx) => {
    const [existingLead] = await tx.select({ id: lead.id }).from(lead).limit(1);
    // "accepted" is a file we have taken in; "processed" is one the worker has already read for the
    // teaser. Both belong to a person who is now asking for the full report.
    const [file] = await tx
      .select({ id: sourceFile.id })
      .from(sourceFile)
      .where(inArray(sourceFile.status, ["accepted", "processed"]))
      .orderBy(desc(sourceFile.createdAt))
      .limit(1);
    if (!file) throw new UserFacingError(409, "Upload a billing export first.", "no_upload");

    const leadId =
      existingLead?.id ??
      (
        await tx
          .insert(lead)
          .values({
            tenantId,
            email: input.email,
            firstName: input.firstName,
            companyName: input.companyName,
            // Unknown until the optional profile step; the columns are required by the schema.
            companyWebsite: "",
            companyDomain: input.email.split("@")[1] ?? "",
            role: input.role ?? "Other",
            country: "OTHER",
            provider: "AWS",
            spendBand: "not_sure",
            biggestProblem: "",
            contactPermission: true,
            consentOrContactBasis: CONTACT_BASIS,
          })
          .returning({ id: lead.id })
      )[0]!.id;

    await tx.update(tenant).set({ name: input.companyName }).where(eq(tenant.id, tenantId));
    // Attach every file and its snapshot in this workspace to the lead.
    await tx.update(sourceFile).set({ leadId }).where(isNull(sourceFile.leadId));
    await tx.insert(consent).values([
      {
        tenantId, leadId, sourceFileId: file.id, provider: "typesafe",
        purpose: "decision_classification", disclosureVersion: TYPESAFE_DISCLOSURE_VERSION,
        granted: input.typesafeConsent,
      },
    ]);

    const [run] = await tx
      .update(snapshotRun)
      .set({ consentBasis, unlockedAt: new Date() })
      .where(and(eq(snapshotRun.sourceFileId, file.id), isNull(snapshotRun.unlockedAt)))
      .returning({ id: snapshotRun.id });

    if (run) {
      await tx
        .insert(job)
        .values({
          tenantId,
          kind: "snapshot.process",
          idempotencyKey: `snapshot.process:${run.id}:full`,
          payload: { snapshotRunId: run.id, sourceFileId: file.id, phase: "full" },
        })
        .onConflictDoNothing({ target: job.idempotencyKey });
    }

    await tx.insert(auditEvent).values({
      tenantId, actorType: "prospect", action: "report.unlocked",
      objectType: "snapshot_run", objectId: run?.id ?? file.id,
      metadata: { consentBasis, role: input.role ?? null },
    });
    return { leadId, snapshotRunId: run?.id ?? null };
  });

  if (result.snapshotRunId) await kickWorker(requestId);
  log.info("report.unlocked", { requestId, snapshotRunId: result.snapshotRunId, consentBasis });

  // Deliver the report behind a verified email: the link proves the address is theirs.
  try {
    await getAuth().api.signInMagicLink({
      body: {
        email: input.email,
        callbackURL: result.snapshotRunId ? `/snapshot/${result.snapshotRunId}` : "/snapshots",
      },
      headers: new Headers(),
    });
  } catch (error) {
    log.error("report.unlock_email_failed", { requestId, error });
  }
  return { ...result, classificationQueued: input.typesafeConsent };
}
