import { lead } from "@cca/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, withAdmin, withTenant } from "@/lib/db";
import { createLead } from "@/lib/leads";

import { validLead } from "./support/fixtures";
import { resetTenants, withOwner } from "./support/owner-db";

beforeEach(resetTenants);
afterAll(closeDb);

async function twoLeads() {
  const { leadInputSchema } = await import("@cca/domain");
  const a = await createLead(leadInputSchema.parse({ ...validLead, companyName: "Acme" }));
  const b = await createLead(
    leadInputSchema.parse({ ...validLead, email: "sam@globex.com", companyName: "Globex", companyWebsite: "globex.com" }),
  );
  return { a, b };
}

describe("tenant isolation (row-level security)", () => {
  it("every table with tenant_id has RLS enabled and a tenant_isolation policy", async () => {
    const rows = await withOwner(async (c) =>
      (
        await c.query(`
          SELECT c.relname AS table, c.relrowsecurity AS rls,
                 EXISTS (SELECT 1 FROM pg_policies p
                         WHERE p.schemaname = 'public' AND p.tablename = c.relname
                           AND p.policyname = 'tenant_isolation') AS has_policy
          FROM pg_class c
          JOIN information_schema.columns col
            ON col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id'
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
          ORDER BY 1`)
      ).rows,
    );
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const row of rows) expect(row, row.table).toMatchObject({ rls: true, has_policy: true });
  });

  it("a tenant sees only its own lead", async () => {
    const { a, b } = await twoLeads();
    const seenByA = await withTenant(a.tenantId, (tx) => tx.select({ id: lead.id }).from(lead));
    expect(seenByA.map((r) => r.id)).toEqual([a.leadId]);
    const seenByB = await withTenant(b.tenantId, (tx) => tx.select({ id: lead.id }).from(lead));
    expect(seenByB.map((r) => r.id)).toEqual([b.leadId]);
  });

  it("without a tenant context the application role sees nothing", async () => {
    await twoLeads();
    const seen = await withTenant("00000000-0000-0000-0000-000000000000", (tx) =>
      tx.select({ id: lead.id }).from(lead),
    );
    expect(seen).toEqual([]);
  });

  it("a tenant cannot write a row into another tenant", async () => {
    const { a, b } = await twoLeads();
    await expect(
      withTenant(a.tenantId, (tx) =>
        tx.insert(lead).values({
          tenantId: b.tenantId,
          email: "x@evil.test",
          firstName: "X",
          companyName: "X",
          companyWebsite: "evil.test",
          companyDomain: "evil.test",
          role: "Other",
          country: "US",
          provider: "AWS",
          spendBand: "not_sure",
          biggestProblem: "x",
          contactPermission: true,
          consentOrContactBasis: "test",
        }),
      ),
    ).rejects.toThrow();
  });

  it("the admin context sees every tenant", async () => {
    await twoLeads();
    const seen = await withAdmin((tx) => tx.select({ id: lead.id }).from(lead));
    expect(seen).toHaveLength(2);
  });

  it("rejects a non-UUID tenant id before touching the database", async () => {
    await expect(withTenant("1 OR 1=1", async () => 1)).rejects.toThrow(/UUID/);
  });
});
