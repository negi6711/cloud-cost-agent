import { readdirSync, rmSync } from "node:fs";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getAuth, mayReceiveLoginLink } from "@/lib/auth";
import { closeDb } from "@/lib/db";
import { readDevInbox } from "@/lib/email";

import { resetTenants, withOwner } from "./support/owner-db";
import { makeVisitor, unlock, uploadAndSnapshot } from "./support/visitors";

const inbox = () => process.env.DEV_INBOX_DIR!;

beforeEach(async () => {
  await resetTenants();
  rmSync(inbox(), { recursive: true, force: true });
});
afterAll(closeDb);

async function leadEmail(leadId: string): Promise<string> {
  return withOwner(async (c) => (await c.query("SELECT email FROM lead WHERE id = $1", [leadId])).rows[0].email);
}

/** A visitor who has uploaded and then unlocked: the only way a lead comes to exist. */
async function unlockedLead() {
  const visitor = await makeVisitor();
  const { runId } = await uploadAndSnapshot(visitor);
  const leadId = await unlock(visitor);
  return { visitor, runId, leadId, email: await leadEmail(leadId) };
}

describe("magic-link login", () => {
  it("allows links only for known leads and admins", async () => {
    const { email } = await unlockedLead();
    expect(await mayReceiveLoginLink(email)).toBe(true);
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
    const { email } = await unlockedLead();
    // Unlocking already sent one link; start from a clean inbox and token store to inspect this one.
    rmSync(inbox(), { recursive: true, force: true });
    await withOwner((c) => c.query("DELETE FROM verification"));
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

describe("the report link", () => {
  it("is sent at the email gate, not before it", async () => {
    const visitor = await makeVisitor();
    const { runId } = await uploadAndSnapshot(visitor);
    // Upload and the deterministic pass happen with no address to send anything to.
    expect(await readDevInbox()).toEqual([]);

    await unlock(visitor);

    const messages = await readDevInbox();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain(encodeURIComponent(`/snapshot/${runId}`));
    // Emails carry a link, never billing content.
    expect(messages[0]!.text).not.toMatch(/EC2|\$|Service total/);
    expect(readdirSync(inbox())).toHaveLength(1);
  });
});
