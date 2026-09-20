import { unlockSchema } from "@cca/domain";

import { unlockReport } from "@/lib/unlock";
import { createVisitorWorkspace, encodeVisitorSession, VISITOR_COOKIE } from "@/lib/visitor-session";

import { validUnlock } from "./fixtures";

export interface TestVisitor {
  tenantId: string;
  cookie: string;
}

let counter = 0;

/** An anonymous workspace plus the Cookie header that browser would send. No lead yet. */
export async function makeVisitor(): Promise<TestVisitor> {
  const tenantId = await createVisitorWorkspace();
  return { tenantId, cookie: `${VISITOR_COOKIE}=${encodeURIComponent(encodeVisitorSession(tenantId))}` };
}

/** Put a lead on a visitor's workspace, as the email gate does. Requires an accepted upload. */
export async function unlock(visitor: TestVisitor, overrides: Record<string, unknown> = {}): Promise<string> {
  counter += 1;
  const input = unlockSchema.parse({
    ...validUnlock,
    email: `lead${counter}@example-co.com`,
    companyName: `Company ${counter}`,
    ...overrides,
  });
  const { leadId } = await unlockReport(visitor.tenantId, input, crypto.randomUUID());
  return leadId;
}

export function jsonRequest(url: string, body: unknown, cookie?: string, method = "POST"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

const CSV = "Service,Amazon EC2($)\nService total,3\n2026-07-01,1\n2026-08-01,2\n";

/** presign → PUT → complete → create run, all as one anonymous visitor would. */
export async function uploadAndSnapshot(
  visitor: TestVisitor,
  text = CSV,
): Promise<{ sourceFileId: string; runId: string }> {
  const { PUT: devPut } = await import("@/app/api/dev-storage/upload/route");
  const { POST: presign } = await import("@/app/api/uploads/presign/route");
  const { POST: complete } = await import("@/app/api/uploads/complete/route");
  const { POST: createSnapshot } = await import("@/app/api/snapshots/route");

  const bytes = new TextEncoder().encode(text);
  const pre = (await (
    await presign(jsonRequest("/api/uploads/presign", { filename: "c.csv", sizeBytes: bytes.byteLength }, visitor.cookie))
  ).json()) as { upload: { url: string }; uploadToken: string };
  await devPut(
    new Request(`http://localhost${pre.upload.url}`, {
      method: "PUT",
      headers: { "content-length": String(bytes.byteLength) },
      body: bytes,
    }),
  );
  const done = (await (
    await complete(
      jsonRequest("/api/uploads/complete", { uploadToken: pre.uploadToken, idempotencyKey: crypto.randomUUID() }, visitor.cookie),
    )
  ).json()) as { sourceFileId: string };
  const snap = (await (
    await createSnapshot(
      jsonRequest("/api/snapshots", { sourceFileId: done.sourceFileId, idempotencyKey: crypto.randomUUID() }, visitor.cookie),
    )
  ).json()) as { snapshotRunId: string };
  return { sourceFileId: done.sourceFileId, runId: snap.snapshotRunId };
}
