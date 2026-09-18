import { leadInputSchema, normalizeCompanyDomain } from "@cca/domain";
import { describe, expect, it } from "vitest";

import { validLead } from "./support/fixtures";

describe("leadInputSchema", () => {
  it("accepts a complete form and normalizes the email", () => {
    const parsed = leadInputSchema.parse(validLead);
    expect(parsed.email).toBe("alex@acme.io");
    expect(parsed.spendBand).toBe("25k_75k");
  });

  it("records low spend bands instead of rejecting them", () => {
    expect(leadInputSchema.safeParse({ ...validLead, spendBand: "under_5k" }).success).toBe(true);
  });

  it.each([
    ["email", "not-an-email"],
    ["spendBand", "10k-25k"],
    ["country", "FR"],
    ["role", "Intern"],
    ["companyWebsite", "localhost"],
    ["biggestProblem", "   "],
  ])("rejects an invalid %s", (field, value) => {
    const result = leadInputSchema.safeParse({ ...validLead, [field]: value });
    expect(result.success).toBe(false);
  });

  it("requires permission to contact", () => {
    expect(leadInputSchema.safeParse({ ...validLead, contactPermission: false }).success).toBe(false);
    const withoutPermission: Record<string, unknown> = { ...validLead };
    delete withoutPermission.contactPermission;
    expect(leadInputSchema.safeParse(withoutPermission).success).toBe(false);
  });

  it("rejects a filled honeypot", () => {
    expect(leadInputSchema.safeParse({ ...validLead, faxNumber: "555" }).success).toBe(false);
  });

  it("drops empty optional text", () => {
    const parsed = leadInputSchema.parse({ ...validLead, desiredOutcome: "   " });
    expect(parsed.desiredOutcome).toBeUndefined();
  });
});

describe("normalizeCompanyDomain", () => {
  it.each([
    ["acme.io", "acme.io"],
    ["www.Acme.io", "acme.io"],
    ["https://acme.co.uk/pricing?x=1", "acme.co.uk"],
    ["http://sub.acme.dev", "sub.acme.dev"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeCompanyDomain(input)).toBe(expected);
  });

  it.each(["", "localhost", "192.168.1.1", "ftp://acme.io", "acme", "javascript:alert(1)"])(
    "rejects %s",
    (input) => {
      expect(normalizeCompanyDomain(input)).toBeNull();
    },
  );
});
