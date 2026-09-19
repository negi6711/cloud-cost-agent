import "server-only";

import type { LeadStatus } from "@cca/config";
import { adminNote, auditEvent, consent, lead, pilotRequest, snapshotFinding, snapshotRun, sourceFile } from "@cca/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { getAuth } from "./auth";
import { withAdmin } from "./db";
import { serverEnv } from "./env";
import { UserFacingError } from "./errors";

/**
 * Founder admin data. Every function here reads across workspaces through withAdmin; callers must
 * have verified the admin session first (lib/admin-route.ts, app/admin pages).
 */

export interface LeadRow {
  id: string;
  createdAt: Date;
  firstName: string;
  email: string;
  companyName: string;
  companyDomain: string;
  role: string;
  country: string;
  provider: string;
  spendBand: string;
  status: LeadStatus;
  uploads: number;
  latestRun: { id: string; status: string } | null;
  pilotRequests: number;
  manualReview: boolean;
}

export async function listLeads(limit = 200): Promise<LeadRow[]> {
  return withAdmin(async (tx) => {
    const leads = await tx.select().from(lead).orderBy(desc(lead.createdAt)).limit(limit);
    if (leads.length === 0) return [];
    const ids = leads.map((l) => l.id);
    const files = await tx
      .select({ leadId: sourceFile.leadId, n: sql<number>`count(*)::int` })
      .from(sourceFile)
      .where(inArray(sourceFile.leadId, ids))
      .groupBy(sourceFile.leadId);
    const runs = await tx
      .select({ leadId: sourceFile.leadId, id: snapshotRun.id, status: snapshotRun.status, createdAt: snapshotRun.createdAt })
      .from(snapshotRun)
      .innerJoin(sourceFile, and(eq(sourceFile.tenantId, snapshotRun.tenantId), eq(sourceFile.id, snapshotRun.sourceFileId)))
      .where(inArray(sourceFile.leadId, ids))
      .orderBy(desc(snapshotRun.createdAt));
    const pilots = await tx
      .select({ leadId: pilotRequest.leadId, manual: pilotRequest.manualReviewOnly })
      .from(pilotRequest)
      .where(inArray(pilotRequest.leadId, ids));

    return leads.map((l) => {
      const latest = runs.find((r) => r.leadId === l.id);
      const mine = pilots.filter((p) => p.leadId === l.id);
      return {
        id: l.id,
        createdAt: l.createdAt,
        firstName: l.firstName,
        email: l.email,
        companyName: l.companyName,
        companyDomain: l.companyDomain,
        role: l.role,
        country: l.country,
        provider: l.provider,
        spendBand: l.spendBand,
        status: l.status as LeadStatus,
        uploads: files.find((f) => f.leadId === l.id)?.n ?? 0,
        latestRun: latest ? { id: latest.id, status: latest.status } : null,
        pilotRequests: mine.filter((p) => !p.manual).length,
        manualReview: mine.some((p) => p.manual),
      };
    });
  });
}

export async function getLeadDetail(leadId: string) {
  return withAdmin(async (tx) => {
    const [l] = await tx.select().from(lead).where(eq(lead.id, leadId)).limit(1);
    if (!l) return null;
    const files = await tx.select().from(sourceFile).where(eq(sourceFile.leadId, leadId)).orderBy(desc(sourceFile.createdAt));
    const fileIds = files.map((f) => f.id);
    const runs = fileIds.length
      ? await tx.select().from(snapshotRun).where(inArray(snapshotRun.sourceFileId, fileIds)).orderBy(desc(snapshotRun.createdAt))
      : [];
    const runIds = runs.map((r) => r.id);
    const findingCounts = runIds.length
      ? await tx
          .select({ runId: snapshotFinding.snapshotRunId, n: sql<number>`count(*)::int`,
                    review: sql<number>`count(*) filter (where ${snapshotFinding.reviewRequired})::int` })
          .from(snapshotFinding)
          .where(inArray(snapshotFinding.snapshotRunId, runIds))
          .groupBy(snapshotFinding.snapshotRunId)
      : [];
    const notes = await tx.select().from(adminNote).where(eq(adminNote.leadId, leadId)).orderBy(desc(adminNote.createdAt));
    const pilots = await tx.select().from(pilotRequest).where(eq(pilotRequest.leadId, leadId)).orderBy(desc(pilotRequest.createdAt));
    const consents = await tx.select().from(consent).where(eq(consent.leadId, leadId));
    return {
      lead: l,
      files: files.map((f) => ({
        ...f,
        typesafeConsent: consents.find((c) => c.sourceFileId === f.id && c.provider === "typesafe")?.granted ?? null,
        runs: runs
          .filter((r) => r.sourceFileId === f.id)
          .map((r) => ({
            ...r,
            findings: findingCounts.find((c) => c.runId === r.id)?.n ?? 0,
            reviewRequired: findingCounts.find((c) => c.runId === r.id)?.review ?? 0,
            issues: (Array.isArray(r.warnings) ? r.warnings : []) as { code: string; severity: string; message: string }[],
          })),
      })),
      notes,
      pilots,
    };
  });
}

export async function setLeadStatus(leadId: string, status: LeadStatus, adminEmail: string): Promise<void> {
  await withAdmin(async (tx) => {
    const [row] = await tx
      .update(lead)
      .set({ status, updatedAt: new Date() })
      .where(eq(lead.id, leadId))
      .returning({ tenantId: lead.tenantId });
    if (!row) throw new UserFacingError(404, "Lead not found.", "not_found");
    await tx.insert(auditEvent).values({
      tenantId: row.tenantId, actorType: "admin", actorId: adminEmail, action: "lead.status_changed",
      objectType: "lead", objectId: leadId, metadata: { status },
    });
  });
}

async function runOwner(tx: Parameters<Parameters<typeof withAdmin>[0]>[0], runId: string) {
  const [row] = await tx
    .select({ tenantId: snapshotRun.tenantId, leadId: sourceFile.leadId, email: lead.email })
    .from(snapshotRun)
    .innerJoin(sourceFile, and(eq(sourceFile.tenantId, snapshotRun.tenantId), eq(sourceFile.id, snapshotRun.sourceFileId)))
    .innerJoin(lead, and(eq(lead.tenantId, sourceFile.tenantId), eq(lead.id, sourceFile.leadId)))
    .where(eq(snapshotRun.id, runId))
    .limit(1);
  if (!row) throw new UserFacingError(404, "Snapshot not found.", "not_found");
  return row;
}

export async function addSnapshotNote(runId: string, body: string, adminEmail: string): Promise<string> {
  return withAdmin(async (tx) => {
    const owner = await runOwner(tx, runId);
    const [note] = await tx
      .insert(adminNote)
      .values({ tenantId: owner.tenantId, leadId: owner.leadId, snapshotRunId: runId, authorEmail: adminEmail, body })
      .returning({ id: adminNote.id });
    await tx.insert(auditEvent).values({
      tenantId: owner.tenantId, actorType: "admin", actorId: adminEmail, action: "snapshot.note_added",
      objectType: "snapshot_run", objectId: runId,
    });
    return note!.id;
  });
}

export function resultUrl(runId: string): string {
  return new URL(`/snapshot/${runId}`, serverEnv().APP_BASE_URL).toString();
}

/** Email the lead a fresh one-time sign-in link to this snapshot. */
export async function resendResultLink(runId: string, adminEmail: string): Promise<void> {
  const owner = await withAdmin((tx) => runOwner(tx, runId));
  await getAuth().api.signInMagicLink({
    body: { email: owner.email, callbackURL: `/snapshot/${runId}` },
    headers: new Headers(),
  });
  await withAdmin((tx) =>
    tx.insert(auditEvent).values({
      tenantId: owner.tenantId, actorType: "admin", actorId: adminEmail, action: "snapshot.link_resent",
      objectType: "snapshot_run", objectId: runId,
    }),
  );
}
