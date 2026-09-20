import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as unlockRoute } from "@/app/api/leads/route";
import { POST as presignRoute } from "@/app/api/uploads/presign/route";
import { addSnapshotNote, getLeadDetail, listLeads, resultUrl, setLeadStatus } from "@/lib/admin";
import { closeDb } from "@/lib/db";
import { resetServerEnvForTests } from "@/lib/env";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { deleteSourceFile } from "@/lib/source-files";
import * as storageModule from "@/lib/storage";

import { resetTenants, withOwner } from "./support/owner-db";
import { jsonRequest, makeVisitor, type TestVisitor, unlock, uploadAndSnapshot } from "./support/visitors";

beforeEach(resetTenants);
afterAll(closeDb);

const count = async (sql: string, params: unknown[] = []) =>
  withOwner(async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n);

/** An upload, its run, and the lead that unlocked it: the state right after the email gate. */
async function unlockedSnapshot(visitor: TestVisitor) {
  const { sourceFileId, runId } = await uploadAndSnapshot(visitor);
  const leadId = await unlock(visitor);
  const [{ storage_key: key }] = await withOwner(async (c) =>
    (await c.query("SELECT storage_key FROM source_file WHERE id = $1", [sourceFileId])).rows,
  );
  return { sourceFileId, runId, leadId, key: key as string };
}

// ------------------------------------------------------------------ guards ---

describe("request guards", () => {
  afterEach(() => {
    process.env.APP_ENV = "test";
    resetServerEnvForTests();
    resetRateLimitsForTests();
  });

  it("rate-limits the upload entry point per client outside tests", async () => {
    process.env.APP_ENV = "development";
    resetServerEnvForTests();
    const post = () =>
      presignRoute(
        new Request("http://localhost/api/uploads/presign", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
          body: JSON.stringify({ filename: "c.csv", sizeBytes: 1024 }),
        }),
      );
    let limited: Response | null = null;
    for (let i = 0; i < 40 && !limited; i++) {
      const res = await post();
      if (res.status === 429) limited = res;
    }
    expect(limited).not.toBeNull();
    expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("refuses cross-site browser requests", async () => {
    const visitor = await makeVisitor();
    const res = await unlockRoute(
      new Request("http://localhost/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example", cookie: visitor.cookie },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
    expect(await count("lead")).toBe(0);
  });

  it("allows same-origin browser requests", async () => {
    const visitor = await makeVisitor();
    await uploadAndSnapshot(visitor);
    const res = await unlockRoute(
      new Request("http://localhost/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie: visitor.cookie },
        body: JSON.stringify({
          email: "alex@acme.io",
          firstName: "Alex",
          companyName: "Acme",
          processingConsent: true,
        }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("refuses an upload session cookie that was tampered with", async () => {
    const visitor = await makeVisitor();
    const tampered = visitor.cookie.slice(0, -2) + "AA";
    const res = await presignRoute(jsonRequest("/api/uploads/presign", { filename: "c.csv", sizeBytes: 10 }, tampered));
    // A bad cookie is not fatal before the gate: the visitor simply gets a fresh workspace.
    expect(res.status).toBe(200);
    expect(await count("tenant")).toBe(2);
  });
});

// ------------------------------------------------------------------ delete ---

describe("delete flow", () => {
  it("removes the file, the snapshot, derived data and queued jobs, and keeps an audit record", async () => {
    const visitor = await makeVisitor();
    const { sourceFileId, runId, key } = await unlockedSnapshot(visitor);
    const local = storageModule.storage();
    expect(await local.head(key)).not.toBeNull();

    const result = await deleteSourceFile(visitor.tenantId, sourceFileId, { type: "prospect", id: null }, "req");
    expect(result).toEqual({ deleted: true, runsDeleted: 1, objectDeleted: true });

    expect(await local.head(key)).toBeNull();
    expect(await count("source_file")).toBe(0);
    expect(await count("snapshot_run WHERE id = $1", [runId])).toBe(0);
    expect(await count("consent")).toBe(0);
    expect(await count("job")).toBe(0);
    const audit = await withOwner(async (c) =>
      (await c.query("SELECT actor_type, action, metadata FROM audit_event WHERE object_id = $1", [sourceFileId])).rows,
    );
    expect(audit).toContainEqual({ actor_type: "prospect", action: "source_file.deleted", metadata: { runsDeleted: 1 } });
    // The lead and their answers remain; only the file and derived data are gone.
    expect(await count("lead")).toBe(1);
  });

  it("cannot delete another tenant's file", async () => {
    const a = await makeVisitor();
    const b = await makeVisitor();
    const { sourceFileId } = await unlockedSnapshot(a);
    const result = await deleteSourceFile(b.tenantId, sourceFileId, { type: "prospect", id: null }, "req");
    expect(result.deleted).toBe(false);
    expect(await count("source_file")).toBe(1);
  });

  it("queues a storage.delete job when the object cannot be removed right now", async () => {
    const visitor = await makeVisitor();
    const { sourceFileId, key } = await unlockedSnapshot(visitor);
    const spy = vi.spyOn(storageModule.storage(), "delete").mockRejectedValueOnce(new Error("storage down"));
    const result = await deleteSourceFile(visitor.tenantId, sourceFileId, { type: "admin", id: "a@b" }, "req");
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
    const a = await makeVisitor();
    const b = await makeVisitor();
    const { runId, leadId } = await unlockedSnapshot(a);
    await uploadAndSnapshot(b);
    await unlock(b);

    const leads = await listLeads();
    expect(leads).toHaveLength(2);
    const row = leads.find((l) => l.id === leadId)!;
    expect(row.uploads).toBe(1);
    expect(row.latestRun).toEqual({ id: runId, status: "queued" });
  });

  it("changes lead status and adds reviewed notes, with audit events", async () => {
    const visitor = await makeVisitor();
    const { runId, leadId } = await unlockedSnapshot(visitor);
    await setLeadStatus(leadId, "snapshot_sent", "founder@admin.test");
    await addSnapshotNote(runId, "Checked ECS with their platform lead.", "founder@admin.test");

    const detail = await getLeadDetail(leadId);
    expect(detail?.lead.status).toBe("snapshot_sent");
    expect(detail?.notes.map((n) => n.body)).toEqual(["Checked ECS with their platform lead."]);
    expect(detail?.files[0]?.typesafeConsent).toBe(true);
    const actions = await withOwner(async (c) =>
      (await c.query("SELECT action FROM audit_event WHERE actor_type = 'admin' ORDER BY created_at")).rows.map((r) => r.action),
    );
    expect(actions).toEqual(["lead.status_changed", "snapshot.note_added"]);
    expect(resultUrl(runId)).toBe(`http://localhost:3000/snapshot/${runId}`);
  });

  it("rejects notes for a snapshot nobody has unlocked yet", async () => {
    const visitor = await makeVisitor();
    const { runId } = await uploadAndSnapshot(visitor);
    await expect(addSnapshotNote(runId, "x", "a@b")).rejects.toThrow(/not found/i);
  });

  it("rejects notes for unknown snapshots", async () => {
    await expect(addSnapshotNote(crypto.randomUUID(), "x", "a@b")).rejects.toThrow(/not found/i);
  });
});
