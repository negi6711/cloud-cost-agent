import "server-only";

import { auditEvent, lead, tenant } from "@cca/db";
import { CONTACT_BASIS, type LeadInput, normalizeCompanyDomain } from "@cca/domain";

import { withTenant } from "./db";

export interface CreatedLead {
  leadId: string;
  tenantId: string;
}

/**
 * Create a lead in its own workspace (tenant). For MVP 0 a tenant represents one lead's workspace
 * (docs/product-spec.md §10). The tenant id is chosen here so the whole insert runs under RLS.
 */
export async function createLead(input: LeadInput): Promise<CreatedLead> {
  const tenantId = crypto.randomUUID();
  const companyDomain = normalizeCompanyDomain(input.companyWebsite);
  if (!companyDomain) throw new Error("createLead: input was not validated");

  return withTenant(tenantId, async (tx) => {
    await tx.insert(tenant).values({ id: tenantId, tenantId, name: input.companyName });
    const [row] = await tx
      .insert(lead)
      .values({
        tenantId,
        email: input.email,
        firstName: input.firstName,
        companyName: input.companyName,
        companyWebsite: input.companyWebsite,
        companyDomain,
        role: input.role,
        country: input.country,
        provider: input.provider,
        spendBand: input.spendBand,
        biggestProblem: input.biggestProblem,
        contactPermission: input.contactPermission,
        consentOrContactBasis: CONTACT_BASIS,
        awsAccountCount: input.awsAccountCount,
        kubernetesUsage: input.kubernetesUsage,
        aiGpuUsage: input.aiGpuUsage,
        recentBillShock: input.recentBillShock,
        desiredOutcome: input.desiredOutcome,
        pilotInterest: input.pilotInterest,
      })
      .returning({ id: lead.id });
    if (!row) throw new Error("createLead: insert returned no row");

    // Qualification analytics only; no contact details in the audit trail.
    await tx.insert(auditEvent).values({
      tenantId,
      actorType: "prospect",
      action: "lead.created",
      objectType: "lead",
      objectId: row.id,
      metadata: {
        spendBand: input.spendBand,
        country: input.country,
        role: input.role,
        provider: input.provider,
      },
    });
    return { leadId: row.id, tenantId };
  });
}
