import { readdirSync, rmSync } from "node:fs";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { POST as createSnapshot } from "@/app/api/snapshots/route";
import { POST as complete } from "@/app/api/uploads/complete/route";
import { PUT as devPut } from "@/app/api/dev-storage/upload/route";
import { POST as presign } from "@/app/api/uploads/presign/route";
import { getAuth, mayReceiveLoginLink } from "@/lib/auth";
import { closeDb } from "@/lib/db";
import { readDevInbox } from "@/lib/email";

import { jsonRequest, makeLead } from "./support/leads";
import { resetTenants, withOwner } from "./support/owner-db";

const inbox = () => process.env.DEV_INBOX_DIR!;

beforeEach(async () => {
  await resetTenants();
  rmSync(inbox(), { recursive: true, force: true });
});
afterAll(closeDb);

async function leadEmail(leadId: string): Promise<string> {
  return withOwner(async (c) => (await c.query("SELECT email FROM lead WHERE id = $1", [leadId])).rows[0].email);
}

describe("magic-link login", () => {
  it("allows links only for known leads and admins", async () => {
    const lead = await makeLead();
    expect(await mayReceiveLoginLink(await leadEmail(lead.session.leadId))).toBe(true);
    expect(await mayReceiveLoginLink("  FOUNDER@admin.test ")).toBe(true);
    expect(await mayReceiveLoginLink("stranger@example.org")).toBe(false);
  });

  it("silently sends nothing to an unknown address", async () => {
    const res = await getAuth().api.signInMagicLink({
      body: { email: "stranger@example.org", callbackURL: "/snapshots" },
      headers: new Headers(),
    });
    expect(res).toMatchObject({ status: true }); // same answer as for a known address
    expect(await readDevInbox()).toEqual([]);
  });

  it("sends a one-time link that carries the callback, and stores only a hashed token", async () => {
    const lead = await makeLead();
    const email = await leadEmail(lead.session.leadId);
    await getAuth().api.signInMagicLink({ body: { email, callbackURL: "/snapshots" }, headers: new Headers() });

    const [message] = await readDevInbox();
    expect(message?.to).toBe(email);
    const url = new URL(message!.text.match(/https?:\/\/\S+/)![0]);
    expect(url.pathname).toBe("/api/auth/magic-link/verify");
    expect(url.searchParams.get("callbackURL")).toBe("/snapshots");
    const token = url.searchParams.get("token")!;

    const stored = await withOwner(async (c) => (await c.query("SELECT identifier FROM verification")).rows);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(token);
  });
});

describe("result link after upload", () => {
  it("emails the lead once when a snapshot is created, and never for a repeat", async () => {
    const lead = await makeLead();
    const bytes = new TextEncoder().encode("Service,Amazon EC2($)\nService total,3\n2026-07-01,1\n2026-08-01,2\n");
    const pre = (await (
      await presign(jsonRequest("/api/uploads/presign", { filename: "c.csv", sizeBytes: bytes.byteLength }, lead.cookie))
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
        jsonRequest("/api/uploads/complete", { uploadToken: pre.uploadToken, idempotencyKey: crypto.randomUUID(), consent: { typesafe: false } }, lead.cookie),
      )
    ).json()) as { sourceFileId: string };

    const body = { sourceFileId: done.sourceFileId, idempotencyKey: crypto.randomUUID() };
    const first = (await (await createSnapshot(jsonRequest("/api/snapshots", body, lead.cookie))).json()) as { snapshotRunId: string };
    await createSnapshot(jsonRequest("/api/snapshots", body, lead.cookie));

    const messages = await readDevInbox();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.to).toBe(await leadEmail(lead.session.leadId));
    expect(messages[0]!.text).toContain(encodeURIComponent(`/snapshot/${first.snapshotRunId}`));
    // Emails carry a link, never billing content.
    expect(messages[0]!.text).not.toMatch(/EC2|\$|Service total/);
    expect(readdirSync(inbox())).toHaveLength(1);
  });
});
