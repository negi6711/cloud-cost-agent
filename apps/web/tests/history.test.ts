import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb } from "@/lib/db";
import { snapshotHistory } from "@/lib/history";
import { createVisitorWorkspace } from "@/lib/visitor-session";

import { resetTenants, withOwner } from "./support/owner-db";

beforeEach(resetTenants);
afterAll(closeDb);

interface Finding {
  key: string;
  title: string;
  category: string;
  /** This month's cost for the subject. */
  now: string;
}

/** A completed run in its own workspace, with findings, as the worker would have left it. */
async function seedRun(month: string, findings: Finding[]): Promise<{ tenantId: string; runId: string }> {
  const tenantId = await createVisitorWorkspace();
  return withOwner(async (c) => {
    const file = await c.query(
      "INSERT INTO source_file (tenant_id, storage_key, original_filename, mime_type, size_bytes, " +
        "sha256, status, idempotency_key) VALUES ($1, $2, 'export.csv', 'text/csv', 10, $3, 'processed', $4) " +
        "RETURNING id",
      [tenantId, `uploads/${tenantId}/${month}`, "a".repeat(64), crypto.randomUUID()],
    );
    const run = await c.query(
      "INSERT INTO snapshot_run (tenant_id, source_file_id, parser_version, question_set_version, " +
        "status, consent_basis, completed_at, summary) VALUES ($1, $2, 'ce-csv/3', 'jev-qs/1', " +
        "'completed', 'typesafe:granted', now(), $3) RETURNING id",
      [tenantId, file.rows[0].id, JSON.stringify({ comparison: { current_month: month } })],
    );
    const runId: string = run.rows[0].id;
    for (const [i, f] of findings.entries()) {
      await c.query(
        "INSERT INTO snapshot_finding (tenant_id, snapshot_run_id, evidence_id, finding_key, dimension, " +
          "label, rank, kind, category, severity, title, explanation, observed_value, model_status, " +
          "final_category, policy_status, review_required, explanation_source, next_action) " +
          "VALUES ($1, $2, $3, $4, 'service', $5, $6, 'material_increase', $7, 'high', $5, 'x', $8, " +
          "'JEV_UNAVAILABLE_REVIEW_REQUIRED', $7, 'REVIEW_REQUIRED', true, 'template', 'x')",
        [tenantId, runId, `ev_${month}_${f.key}`, f.key, f.title, i + 1, f.category, f.now],
      );
    }
    return { tenantId, runId };
  });
}

describe("what happened to last month's findings", () => {
  it("matches by subject across two workspaces, because month two lands in a new one", async () => {
    // The visitor cookie lives 24 hours, so a customer returning a month later is a new workspace.
    // Their verified email is the only thread between the two, which is why this runs at read time.
    const june = await seedRun("2026-06", [
      { key: "ec2", title: "Amazon EC2 up $1,892.16/month", category: "ESCALATE", now: "6000.00" },
      { key: "s3", title: "Amazon S3 up $317.40/month", category: "MONITOR", now: "1300.00" },
    ]);
    const july = await seedRun("2026-07", [
      { key: "ec2", title: "Amazon EC2 up $1,829.09/month", category: "ESCALATE", now: "7800.00" },
      { key: "nat", title: "New service: NAT Gateway", category: "REQUEST_EVIDENCE", now: "630.00" },
    ]);
    expect(june.tenantId).not.toBe(july.tenantId);

    const history = await snapshotHistory([june.tenantId, july.tenantId], july.runId, {
      comparison: { current_month: "2026-07" },
    });

    expect(history).not.toBeNull();
    expect(history!.previousRunId).toBe(june.runId);
    expect(history!.previousMonth).toBe("2026-06");
    expect(history!.carried.map((f) => [f.findingKey, f.outcome])).toEqual([["ec2", "grew"]]);
    expect(history!.carried[0]).toMatchObject({ previousCategory: "ESCALATE", previousCurrent: "6000.00" });
    expect(history!.resolved.map((f) => f.findingKey)).toEqual(["s3"]);
    expect(history!.newCount).toBe(1); // the NAT gateway
  });

  it("reads upload order as billing order only when the months agree", async () => {
    // Someone uploads August, then goes back for July. July is not news about August.
    const august = await seedRun("2026-08", [
      { key: "ec2", title: "EC2", category: "INVESTIGATE", now: "5000.00" },
    ]);
    const july = await seedRun("2026-07", [
      { key: "ec2", title: "EC2", category: "INVESTIGATE", now: "4000.00" },
    ]);
    const tenants = [august.tenantId, july.tenantId];

    const forAugust = await snapshotHistory(tenants, august.runId, { comparison: { current_month: "2026-08" } });
    expect(forAugust!.previousRunId).toBe(july.runId);
    expect(forAugust!.carried[0].outcome).toBe("grew");

    // The July report has nothing earlier to compare against, even though August was uploaded first.
    const forJuly = await snapshotHistory(tenants, july.runId, { comparison: { current_month: "2026-07" } });
    expect(forJuly).toBeNull();
  });

  it("says nothing on a first snapshot", async () => {
    const only = await seedRun("2026-07", [{ key: "ec2", title: "EC2", category: "MONITOR", now: "10.00" }]);
    expect(await snapshotHistory([only.tenantId], only.runId, { comparison: { current_month: "2026-07" } }))
      .toBeNull();
  });

  it("reports a finding that shrank as still here, not as resolved", async () => {
    const june = await seedRun("2026-06", [{ key: "ec2", title: "EC2", category: "ESCALATE", now: "9000.00" }]);
    const july = await seedRun("2026-07", [{ key: "ec2", title: "EC2", category: "MONITOR", now: "6000.00" }]);
    const history = await snapshotHistory([june.tenantId, july.tenantId], july.runId, {
      comparison: { current_month: "2026-07" },
    });
    expect(history!.carried.map((f) => f.outcome)).toEqual(["shrank"]);
    expect(history!.resolved).toEqual([]);
  });
});
