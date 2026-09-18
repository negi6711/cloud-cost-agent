import { createHash } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PUT as devPut } from "@/app/api/dev-storage/upload/route";
import { GET as getStatus } from "@/app/api/snapshots/[id]/route";
import { POST as createSnapshot } from "@/app/api/snapshots/route";
import { POST as complete } from "@/app/api/uploads/complete/route";
import { POST as presign } from "@/app/api/uploads/presign/route";
import { closeDb } from "@/lib/db";
import { signToken } from "@/lib/signing";
import { LOCAL_PUT_PURPOSE } from "@/lib/storage/local";
import { LocalStorage } from "@/lib/storage/local";

import { jsonRequest, makeLead, type TestLead } from "./support/leads";
import { resetTenants, withOwner } from "./support/owner-db";

const CSV = "Service,Amazon EC2($),Amazon S3($),Total costs($)\nService total,300,30,330\n2026-07-01,100,10,110\n2026-08-01,200,20,220\n";

beforeEach(resetTenants);
afterAll(closeDb);

async function presignFor(lead: TestLead, bytes: Uint8Array<ArrayBuffer>, filename = "costs.csv") {
  const res = await presign(jsonRequest("/api/uploads/presign", { filename, sizeBytes: bytes.byteLength }, lead.cookie));
  expect(res.status).toBe(200);
  return (await res.json()) as { upload: { url: string; headers: Record<string, string> }; uploadToken: string };
}

async function put(url: string, bytes: Uint8Array<ArrayBuffer>, contentLength = bytes.byteLength) {
  return devPut(
    new Request(`http://localhost${url}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-length": String(contentLength) },
      body: bytes,
    }),
  );
}

async function completeFor(lead: TestLead, uploadToken: string, idempotencyKey = crypto.randomUUID(), typesafe = true) {
  const res = await complete(
    jsonRequest("/api/uploads/complete", { uploadToken, idempotencyKey, consent: { typesafe } }, lead.cookie),
  );
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

/** presign + PUT + complete. */
async function upload(lead: TestLead, text: string | Uint8Array<ArrayBuffer>, typesafe = true) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const { upload: u, uploadToken } = await presignFor(lead, bytes);
  expect((await put(u.url, bytes)).status).toBe(200);
  return completeFor(lead, uploadToken, crypto.randomUUID(), typesafe);
}

const owner = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  withOwner(async (c) => (await c.query(sql, params)).rows as T[]);

describe("upload → snapshot flow", () => {
  it("requires the lead session cookie", async () => {
    const res = await presign(jsonRequest("/api/uploads/presign", { filename: "a.csv", sizeBytes: 10 }));
    expect(res.status).toBe(401);
  });

  it("refuses files over 25 MB before issuing an upload URL", async () => {
    const lead = await makeLead();
    const res = await presign(
      jsonRequest("/api/uploads/presign", { filename: "big.csv", sizeBytes: 25 * 1024 * 1024 + 1 }, lead.cookie),
    );
    expect(res.status).toBe(400);
  });

  it("stores the file privately, records hash and consent, and queues exactly one job", async () => {
    const lead = await makeLead();
    const { status, body } = await upload(lead, CSV);
    expect(status).toBe(200);
    expect(body.status).toBe("accepted");

    const [file] = await owner("SELECT * FROM source_file WHERE id = $1", [body.sourceFileId]);
    expect(file).toMatchObject({
      tenant_id: lead.session.tenantId,
      lead_id: lead.session.leadId,
      status: "accepted",
      mime_type: "text/csv",
      original_filename: "costs.csv",
      sha256: createHash("sha256").update(CSV).digest("hex"),
    });
    expect(String(file!.storage_key)).toMatch(new RegExp(`^uploads/${lead.session.tenantId}/`));

    const consents = await owner("SELECT provider, granted, disclosure_version FROM consent WHERE source_file_id = $1", [
      body.sourceFileId,
    ]);
    expect(consents).toEqual([{ provider: "typesafe", granted: true, disclosure_version: "typesafe-disclosure-v1" }]);

    const key = crypto.randomUUID();
    const first = await createSnapshot(jsonRequest("/api/snapshots", { sourceFileId: body.sourceFileId, idempotencyKey: key }, lead.cookie));
    expect(first.status).toBe(201);
    const { snapshotRunId } = (await first.json()) as { snapshotRunId: string };

    // Repeating the request, even with a new client key, returns the same run and enqueues nothing new.
    const again = await createSnapshot(
      jsonRequest("/api/snapshots", { sourceFileId: body.sourceFileId, idempotencyKey: crypto.randomUUID() }, lead.cookie),
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { snapshotRunId: string }).snapshotRunId).toBe(snapshotRunId);

    const jobs = await owner("SELECT kind, status, payload FROM job WHERE tenant_id = $1", [lead.session.tenantId]);
    expect(jobs).toEqual([
      { kind: "snapshot.process", status: "queued", payload: { snapshotRunId, sourceFileId: body.sourceFileId } },
    ]);
    const [run] = await owner("SELECT status, consent_basis, parser_version FROM snapshot_run WHERE id = $1", [snapshotRunId]);
    expect(run).toEqual({ status: "queued", consent_basis: "typesafe:granted", parser_version: "ce-csv/1" });

    const statusRes = await getStatus(
      new Request(`http://localhost/api/snapshots/${snapshotRunId}`, { headers: { cookie: lead.cookie } }),
      { params: Promise.resolve({ id: snapshotRunId }) },
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as Record<string, unknown>;
    expect(statusBody).toMatchObject({ id: snapshotRunId, status: "queued", completed: false });
    expect(statusBody).not.toHaveProperty("findings");
  });

  it("records a declined consent on the run", async () => {
    const lead = await makeLead();
    const { body } = await upload(lead, CSV, false);
    const res = await createSnapshot(
      jsonRequest("/api/snapshots", { sourceFileId: body.sourceFileId, idempotencyKey: crypto.randomUUID() }, lead.cookie),
    );
    const { snapshotRunId } = (await res.json()) as { snapshotRunId: string };
    const [run] = await owner("SELECT consent_basis FROM snapshot_run WHERE id = $1", [snapshotRunId]);
    expect(run!.consent_basis).toBe("typesafe:declined");
  });

  it("is idempotent for a repeated completion with the same key", async () => {
    const lead = await makeLead();
    const bytes = new TextEncoder().encode(CSV);
    const { upload: u, uploadToken } = await presignFor(lead, bytes);
    await put(u.url, bytes);
    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([completeFor(lead, uploadToken, key), completeFor(lead, uploadToken, key)]);
    expect(a.body.sourceFileId).toBe(b.body.sourceFileId);
    const [{ n }] = await owner<{ n: number }>("SELECT count(*)::int AS n FROM source_file WHERE lead_id = $1", [lead.session.leadId]);
    expect(n).toBe(1);
  });

  it("returns the earlier file when the same bytes are uploaded again", async () => {
    const lead = await makeLead();
    const first = await upload(lead, CSV);
    const second = await upload(lead, CSV);
    expect(second.body).toMatchObject({ status: "accepted", sourceFileId: first.body.sourceFileId, duplicateOf: first.body.sourceFileId });
    const [{ n }] = await owner<{ n: number }>("SELECT count(*)::int AS n FROM source_file WHERE lead_id = $1", [lead.session.leadId]);
    expect(n).toBe(1);
  });

  it("rejects a spreadsheet named .csv by its content, and it cannot be analyzed", async () => {
    const lead = await makeLead();
    const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode("fake workbook")]);
    const { status, body } = await upload(lead, xlsx);
    expect(status).toBe(200);
    expect(body.status).toBe("rejected");
    expect(body.message).toMatch(/not a CSV/);

    const res = await createSnapshot(
      jsonRequest("/api/snapshots", { sourceFileId: body.sourceFileId, idempotencyKey: crypto.randomUUID() }, lead.cookie),
    );
    expect(res.status).toBe(409);
  });

  it("rejects a PUT whose size differs from the signed size", async () => {
    const lead = await makeLead();
    const bytes = new TextEncoder().encode(CSV);
    const { upload: u } = await presignFor(lead, bytes);
    const bigger = new TextEncoder().encode(`${CSV}extra`);
    expect((await put(u.url, bigger)).status).toBe(400);
  });

  it("rejects expired and tampered upload URLs", async () => {
    const lead = await makeLead();
    const key = `uploads/${lead.session.tenantId}/${crypto.randomUUID()}`;
    const expired = signToken(process.env.STORAGE_URL_SIGNING_SECRET!, LOCAL_PUT_PURPOSE, { key, contentLength: 3 }, 60, Date.now() - 3_600_000);
    expect((await put(`/api/dev-storage/upload?token=${encodeURIComponent(expired)}`, new Uint8Array([1, 2, 3]))).status).toBe(403);

    const bytes = new TextEncoder().encode(CSV);
    const { upload: u } = await presignFor(lead, bytes);
    const tampered = u.url.replace(/token=([^.]+)\./, (_m, p: string) => `token=${p.slice(0, -2)}AA.`);
    expect((await put(tampered, bytes)).status).toBe(403);
  });

  it("never resolves a storage path outside the storage root", () => {
    const local = new LocalStorage(process.env.LOCAL_STORAGE_DIR!, "x".repeat(32), 60);
    for (const key of ["../../etc/passwd", "uploads/../../secret", "uploads/a/b", `uploads/${crypto.randomUUID()}/../x`]) {
      expect(() => local.pathFor(key)).toThrow(/invalid storage key/);
    }
  });
});

describe("cross-tenant access", () => {
  it("one lead cannot complete, analyze, or read another lead's upload", async () => {
    const a = await makeLead();
    const b = await makeLead();

    const bytes = new TextEncoder().encode(CSV);
    const { upload: u, uploadToken } = await presignFor(a, bytes);
    await put(u.url, bytes);

    // B presents A's upload token.
    const stolen = await completeFor(b, uploadToken);
    expect(stolen.status).toBe(403);

    const mine = await completeFor(a, uploadToken);
    const snap = await createSnapshot(
      jsonRequest("/api/snapshots", { sourceFileId: mine.body.sourceFileId, idempotencyKey: crypto.randomUUID() }, a.cookie),
    );
    const { snapshotRunId } = (await snap.json()) as { snapshotRunId: string };

    const bCreates = await createSnapshot(
      jsonRequest("/api/snapshots", { sourceFileId: mine.body.sourceFileId, idempotencyKey: crypto.randomUUID() }, b.cookie),
    );
    expect(bCreates.status).toBe(404);

    const bReads = await getStatus(
      new Request(`http://localhost/api/snapshots/${snapshotRunId}`, { headers: { cookie: b.cookie } }),
      { params: Promise.resolve({ id: snapshotRunId }) },
    );
    expect(bReads.status).toBe(404);
  });
});
