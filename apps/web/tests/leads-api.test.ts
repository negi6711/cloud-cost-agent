import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/leads/route";
import { closeDb } from "@/lib/db";
import { decodeLeadSession, LEAD_SESSION_COOKIE } from "@/lib/lead-session";

import { validLead } from "./support/fixtures";
import { resetTenants, withOwner } from "./support/owner-db";

function post(body: unknown): Request {
  return new Request("http://localhost/api/leads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(resetTenants);
afterAll(closeDb);

describe("POST /api/leads", () => {
  it("creates a lead in its own tenant and sets a signed upload-session cookie", async () => {
    const res = await POST(post(validLead));
    expect(res.status).toBe(201);
    const { leadId } = (await res.json()) as { leadId: string };

    const cookie = res.cookies.get(LEAD_SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    const session = decodeLeadSession(cookie?.value);
    expect(session?.leadId).toBe(leadId);

    const rows = await withOwner(async (c) =>
      (
        await c.query(
          "SELECT l.tenant_id, l.email, l.company_domain, l.spend_band, l.status, l.consent_or_contact_basis, t.name " +
            "FROM lead l JOIN tenant t ON t.id = l.tenant_id WHERE l.id = $1",
          [leadId],
        )
      ).rows,
    );
    expect(rows).toEqual([
      {
        tenant_id: session?.tenantId,
        email: "alex@acme.io",
        company_domain: "acme.io",
        spend_band: "25k_75k",
        status: "new",
        consent_or_contact_basis: "consent:contact-form-v1",
        name: "Acme",
      },
    ]);
  });

  it("writes an audit event without contact details", async () => {
    const res = await POST(post(validLead));
    const { leadId } = (await res.json()) as { leadId: string };
    const events = await withOwner(async (c) =>
      (await c.query("SELECT action, actor_type, metadata FROM audit_event WHERE object_id = $1", [leadId]))
        .rows,
    );
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("lead.created");
    expect(JSON.stringify(events[0].metadata)).not.toMatch(/acme\.io|Alex/);
  });

  it("returns field errors for an invalid form and stores nothing", async () => {
    const res = await POST(post({ ...validLead, email: "nope", spendBand: "lots" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors: Record<string, string[]> };
    expect(Object.keys(body.fieldErrors).sort()).toEqual(["email", "spendBand"]);
    const count = await withOwner(async (c) => (await c.query("SELECT count(*)::int AS n FROM lead")).rows[0].n);
    expect(count).toBe(0);
  });

  it("answers a filled honeypot generically and stores nothing", async () => {
    const res = await POST(post({ ...validLead, faxNumber: "555-0100" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.fieldErrors).toBeUndefined();
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an oversized body", JSON.stringify({ ...validLead, biggestProblem: "x".repeat(20_000) })],
  ])("rejects %s with a generic error", async (_label, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
