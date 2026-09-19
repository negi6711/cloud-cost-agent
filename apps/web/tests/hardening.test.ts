import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as createLeadRoute } from "@/app/api/leads/route";
import { PUT as devPut } from "@/app/api/dev-storage/upload/route";
import { POST as createSnapshotRoute } from "@/app/api/snapshots/route";
import { POST as completeRoute } from "@/app/api/uploads/complete/route";
import { POST as presignRoute } from "@/app/api/uploads/presign/route";
import { addSnapshotNote, getLeadDetail, listLeads, resultUrl, setLeadStatus } from "@/lib/admin";
import { closeDb } from "@/lib/db";
import { resetServerEnvForTests } from "@/lib/env";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { deleteSourceFile } from "@/lib/source-files";
import * as storageModule from "@/lib/storage";

import { validLead } from "./support/fixtures";
import { jsonRequest, makeLead, type TestLead } from "./support/leads";
import { resetTenants, withOwner } from "./support/owner-db";

const CSV = "Service,Amazon EC2($)\nService total,3\n2026-07-01,1\n2026-08-01,2\n";

beforeEach(resetTenants);
afterAll(closeDb);

async function uploadedSnapshot(lead: TestLead): Promise<{ sourceFileId: string; runId: string; key: string }> {
  const bytes = new TextEncoder().encode(CSV);
  const pre = (await (
    await presignRoute(jsonRequest("/api/uploads/presign", { filename: "c.csv", sizeBytes: bytes.byteLength }, lead.cookie))
  ).json()) as { upload: { url: string }; uploadToken: string };
  await devPut(new Request(`http://localhost${pre.upload.url}`, {
    method: "PUT", headers: { "content-length": String(bytes.byteLength) }, body: bytes,
  }));
  const done = (await (await completeRoute(jsonRequest("/api/uploads/complete",
    { uploadToken: pre.uploadToken, idempotencyKey: crypto.randomUUID(), consent: { typesafe: true } }, lead.cookie))).json()) as {
    sourceFileId: string;
  };
  const snap = (await (await createSnapshotRoute(jsonRequest("/api/snapshots",
    { sourceFileId: done.sourceFileId, idempotencyKey: crypto.randomUUID() }, lead.cookie))).json()) as { snapshotRunId: string };
  const [{ storage_key: key }] = await withOwner(async (c) =>
    (await c.query("SELECT storage_key FROM source_file WHERE id = $1", [done.sourceFileId])).rows);
  return { sourceFileId: done.sourceFileId, runId: snap.snapshotRunId, key };
}

const count = async (sql: string, params: unknown[] = []) =>
  withOwner(async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n);

// ------------------------------------------------------------------ guards ---

describe("request guards", () => {
  afterEach(() => {
    process.env.APP_ENV = "test";
    resetServerEnvForTests();
    resetRateLimitsForTests();
  });

  it("rate-limits the lead form per client outside tests", async () => {
    process.env.APP_ENV = "development";
    resetServerEnvForTests();
    const post = () => createLeadRoute(new Request("http://localhost/api/leads", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ ...validLead, email: `rl${crypto.randomUUID().slice(0, 8)}@example-co.com` }),
    }));
    for (let i = 0; i < 10; i++) expect((await post()).status).toBe(201);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("refuses cross-site browser requests", async () => {
    const res = await createLeadRoute(new Request("http://localhost/api/leads", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify(validLead),
    }));
    expect(res.status).toBe(403);
    expect(await count("lead")).toBe(0);
  });

  it("allows same-origin browser requests", async () => {
    const res = await createLeadRoute(new Request("http://localhost/api/leads", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify(validLead),
    }));
    expect(res.status).toBe(201);
  });
});

// ------------------------------------------------------------------ delete ---

describe("delete flow", () => {
  it("removes the file, the snapshot, derived data and queued jobs, and keeps an audit record", async () => {
    const lead = await makeLead();
    const { sourceFileId, runId, key } = await uploadedSnapshot(lead);
    const local = storageModule.storage();
    expect(await local.head(key)).not.toBeNull();

    const result = await deleteSourceFile(lead.session.tenantId, sourceFileId, { type: "prospect", id: null }, "req");
    expect(result).toEqual({ deleted: true, runsDeleted: 1, objectDeleted: true });

    expect(await local.head(key)).toBeNull();
    expect(await count("source_file")).toBe(0);
    expect(await count("snapshot_run WHERE id = $1", [runId])).toBe(0);
    expect(await count("consent")).toBe(0);
    expect(await count("job")).toBe(0);
    const audit = await withOwner(async (c) =>
      (await c.query("SELECT actor_type, action, metadata FROM audit_event WHERE object_id = $1", [sourceFileId])).rows);
    expect(audit).toContainEqual({ actor_type: "prospect", action: "source_file.deleted", metadata: { runsDeleted: 1 } });
    // The lead and their qualification answers remain; only the file and derived data are gone.
    expect(await count("lead")).toBe(1);
  });

  it("cannot delete another tenant's file", async () => {
    const a = await makeLead();
    const b = await makeLead();
    const { sourceFileId } = await uploadedSnapshot(a);
    const result = await deleteSourceFile(b.session.tenantId, sourceFileId, { type: "prospect", id: null }, "req");
    expect(result.deleted).toBe(false);
    expect(await count("source_file")).toBe(1);
  });

  it("queues a storage.delete job when the object cannot be removed right now", async () => {
    const lead = await makeLead();
    const { sourceFileId, key } = await uploadedSnapshot(lead);
    const spy = vi.spyOn(storageModule.storage(), "delete").mockRejectedValueOnce(new Error("storage down"));
    const result = await deleteSourceFile(lead.session.tenantId, sourceFileId, { type: "admin", id: "a@b" }, "req");
    spy.mockRestore();
    expect(result).toMatchObject({ deleted: true, objectDeleted: false });
    const jobs = await withOwner(async (c) => (await c.query("SELECT kind, payload FROM job")).rows);
    expect(jobs).toEqual([{ kind: "storage.delete", payload: { storageKey: key } }]);
    expect(await count("source_file")).toBe(0); // rows are gone either way
  });
});

// ------------------------------------------------------------------- admin ---

describe("admin data", () => {
  it("lists leads across workspaces with upload and snapshot state", async () => {
    const a = await makeLead();
    await makeLead();
    const { runId } = await uploadedSnapshot(a);
    const leads = await listLeads();
    expect(leads).toHaveLength(2);
    const row = leads.find((l) => l.id === a.session.leadId)!;
    expect(row.uploads).toBe(1);
    expect(row.latestRun).toEqual({ id: runId, status: "queued" });
  });

  it("changes lead status and adds reviewed notes, with audit events", async () => {
    const a = await makeLead();
    const { runId } = await uploadedSnapshot(a);
    await setLeadStatus(a.session.leadId, "snapshot_sent", "founder@admin.test");
    await addSnapshotNote(runId, "Checked ECS with their platform lead.", "founder@admin.test");

    const detail = await getLeadDetail(a.session.leadId);
    expect(detail?.lead.status).toBe("snapshot_sent");
    expect(detail?.notes.map((n) => n.body)).toEqual(["Checked ECS with their platform lead."]);
    expect(detail?.files[0]?.typesafeConsent).toBe(true);
    const actions = await withOwner(async (c) =>
      (await c.query("SELECT action FROM audit_event WHERE actor_type = 'admin' ORDER BY created_at")).rows.map((r) => r.action));
    expect(actions).toEqual(["lead.status_changed", "snapshot.note_added"]);
    expect(resultUrl(runId)).toBe(`http://localhost:3000/snapshot/${runId}`);
  });

  it("rejects notes for unknown snapshots", async () => {
    await expect(addSnapshotNote(crypto.randomUUID(), "x", "a@b")).rejects.toThrow(/not found/i);
  });
});
