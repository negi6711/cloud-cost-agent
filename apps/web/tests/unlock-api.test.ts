import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/leads/route";
import { closeDb } from "@/lib/db";

import { validUnlock } from "./support/fixtures";
import { resetTenants, withOwner } from "./support/owner-db";
import { jsonRequest, makeVisitor, uploadAndSnapshot } from "./support/visitors";

beforeEach(resetTenants);
afterAll(closeDb);

const owner = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  withOwner(async (c) => (await c.query(sql, params)).rows as T[]);

describe("POST /api/leads (the email gate under the teaser)", () => {
  it("claims the visitor's workspace, records consent, and queues the classification phase", async () => {
    const visitor = await makeVisitor();
    const { sourceFileId, runId } = await uploadAndSnapshot(visitor);

    const res = await POST(jsonRequest("/api/leads", validUnlock, visitor.cookie));
    expect(res.status).toBe(201);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      snapshotRunId: runId,
      classificationQueued: true,
    });

    const [lead] = await owner(
      "SELECT l.tenant_id, l.email, l.company_domain, l.role, l.status, l.email_verified_at, t.name " +
        "FROM lead l JOIN tenant t ON t.id = l.tenant_id",
    );
    expect(lead).toEqual({
      tenant_id: visitor.tenantId,
      email: "alex@acme.io",
      company_domain: "acme.io",
      role: "Head of Platform",
      status: "new",
      // Set when the emailed link is actually opened, not when the address is typed in.
      email_verified_at: null,
      name: "Acme",
    });

    // The upload made before the gate is attached to the person who just claimed it.
    expect(await owner("SELECT lead_id IS NOT NULL AS claimed FROM source_file WHERE id = $1", [sourceFileId])).toEqual([
      { claimed: true },
    ]);
    expect(await owner("SELECT provider, granted, disclosure_version FROM consent")).toEqual([
      { provider: "typesafe", granted: true, disclosure_version: "typesafe-disclosure-v1" },
    ]);

    const [run] = await owner("SELECT consent_basis, unlocked_at IS NOT NULL AS unlocked FROM snapshot_run WHERE id = $1", [
      runId,
    ]);
    expect(run).toEqual({ consent_basis: "typesafe:granted", unlocked: true });

    // The teaser job plus the full phase, and only the full phase carries model classification.
    const jobs = await owner<{ idempotency_key: string; payload: Record<string, unknown> }>(
      "SELECT idempotency_key, payload FROM job ORDER BY created_at",
    );
    expect(jobs.map((j) => j.idempotency_key)).toEqual([`snapshot.process:${runId}`, `snapshot.process:${runId}:full`]);
    expect(jobs[1]!.payload).toMatchObject({ snapshotRunId: runId, phase: "full" });
  });

  it("records a declined model consent and still unlocks the report", async () => {
    const visitor = await makeVisitor();
    const { runId } = await uploadAndSnapshot(visitor);

    const res = await POST(jsonRequest("/api/leads", { ...validUnlock, typesafeConsent: false }, visitor.cookie));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { classificationQueued: boolean }).classificationQueued).toBe(false);

    expect(await owner("SELECT granted FROM consent")).toEqual([{ granted: false }]);
    const [run] = await owner("SELECT consent_basis FROM snapshot_run WHERE id = $1", [runId]);
    expect(run!.consent_basis).toBe("typesafe:declined");
  });

  it("writes an audit event without contact details", async () => {
    const visitor = await makeVisitor();
    await uploadAndSnapshot(visitor);
    await POST(jsonRequest("/api/leads", validUnlock, visitor.cookie));

    const events = await owner<{ action: string; metadata: unknown }>(
      "SELECT action, metadata FROM audit_event WHERE action = 'report.unlocked'",
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]!.metadata)).not.toMatch(/acme\.io|Alex/);
  });

  it("refuses an unlock with no upload behind it", async () => {
    const visitor = await makeVisitor();
    const res = await POST(jsonRequest("/api/leads", validUnlock, visitor.cookie));
    expect(res.status).toBe(409);
    expect(await owner("SELECT id FROM lead")).toEqual([]);
  });

  it("refuses an unlock with no visitor session", async () => {
    const res = await POST(jsonRequest("/api/leads", validUnlock));
    expect(res.status).toBe(401);
    expect(await owner("SELECT id FROM lead")).toEqual([]);
  });

  it("returns field errors for an invalid form and stores nothing", async () => {
    const visitor = await makeVisitor();
    await uploadAndSnapshot(visitor);
    const res = await POST(
      jsonRequest("/api/leads", { ...validUnlock, email: "nope", processingConsent: false }, visitor.cookie),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors: Record<string, string[]> };
    expect(Object.keys(body.fieldErrors).sort()).toEqual(["email", "processingConsent"]);
    expect(await owner("SELECT id FROM lead")).toEqual([]);
  });

  it("answers a filled honeypot generically and stores nothing", async () => {
    const visitor = await makeVisitor();
    await uploadAndSnapshot(visitor);
    const res = await POST(jsonRequest("/api/leads", { ...validUnlock, faxNumber: "555-0100" }, visitor.cookie));
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).not.toHaveProperty("fieldErrors");
    expect(await owner("SELECT id FROM lead")).toEqual([]);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an oversized body", JSON.stringify({ ...validUnlock, firstName: "x".repeat(20_000) })],
  ])("rejects %s with a generic error", async (_label, body) => {
    const visitor = await makeVisitor();
    const res = await POST(
      new Request("http://localhost/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: visitor.cookie },
        body,
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
