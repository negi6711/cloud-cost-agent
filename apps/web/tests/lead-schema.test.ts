import { profileSchema, unlockSchema } from "@cca/domain";
import { describe, expect, it } from "vitest";

import { validProfile, validUnlock } from "./support/fixtures";

describe("unlockSchema", () => {
  it("accepts the gate form and normalizes the email", () => {
    const parsed = unlockSchema.parse(validUnlock);
    expect(parsed.email).toBe("alex@acme.io");
    expect(parsed.typesafeConsent).toBe(true);
  });

  it("makes the role optional and model consent default to off", () => {
    const rest = { ...validUnlock, role: undefined, typesafeConsent: undefined };
    const parsed = unlockSchema.parse(rest);
    expect(parsed.role).toBeUndefined();
    expect(parsed.typesafeConsent).toBe(false);
  });

  it.each([
    ["email", "not-an-email"],
    ["firstName", "   "],
    ["companyName", ""],
    ["role", "Intern"],
  ])("rejects an invalid %s", (field, value) => {
    expect(unlockSchema.safeParse({ ...validUnlock, [field]: value }).success).toBe(false);
  });

  it("requires permission to process the upload", () => {
    expect(unlockSchema.safeParse({ ...validUnlock, processingConsent: false }).success).toBe(false);
    expect(unlockSchema.safeParse({ ...validUnlock, processingConsent: undefined }).success).toBe(false);
  });

  it("rejects a filled honeypot", () => {
    expect(unlockSchema.safeParse({ ...validUnlock, faxNumber: "555" }).success).toBe(false);
  });
});

describe("profileSchema", () => {
  it("accepts a complete set of answers", () => {
    expect(profileSchema.parse(validProfile).spendBand).toBe("25k_75k");
  });

  it("accepts an empty form: every answer is optional", () => {
    expect(profileSchema.parse({})).toEqual({});
  });

  it("drops a blank free-text answer instead of storing whitespace", () => {
    expect(profileSchema.parse({ biggestProblem: "   " }).biggestProblem).toBeUndefined();
  });

  it.each([
    ["spendBand", "10k-25k"],
    ["country", "FR"],
    ["provider", "Oracle"],
  ])("rejects an invalid %s", (field, value) => {
    expect(profileSchema.safeParse({ [field]: value }).success).toBe(false);
  });
});
