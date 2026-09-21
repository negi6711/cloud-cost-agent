import "server-only";

import { snapshotFinding, snapshotRun } from "@cca/db";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";

import { withTenant } from "./db";

/**
 * "Last month we said this. What happened?"
 *
 * Every other view in the product answers a question about one file. This one is the only thing
 * that can show the product did anything: it matches this report's findings against the previous
 * report's by subject (`finding_key`, stable across files) and says which are still here, which
 * grew, and which are gone.
 *
 * It runs at read time, across every workspace the signed-in viewer owns, which is what makes it
 * work at all: an upload a month later usually lands in a *new* workspace, because the visitor
 * cookie only lives 24 hours. Their verified email is the thread between the two, and RLS forbids a
 * single query spanning both, so each workspace is read in its own context and merged here.
 */

export type FindingOutcome = "grew" | "shrank" | "unchanged" | "resolved";

export interface CarriedFinding {
  findingKey: string;
  title: string;
  /** What we published about it last time. */
  previousCategory: string;
  previousMonth: string | null;
  previousDelta: string | null;
  previousCurrent: string | null;
  currentDelta: string | null;
  currentCurrent: string | null;
  outcome: FindingOutcome;
}

export interface SnapshotHistory {
  previousRunId: string;
  previousMonth: string | null;
  /** Findings that were in the previous report and are in this one too. */
  carried: CarriedFinding[];
  /** Findings from the previous report that are not findings this time. */
  resolved: CarriedFinding[];
  /** Subjects that are new this time. */
  newCount: number;
}

interface RunRow {
  id: string;
  tenantId: string;
  month: string | null;
  createdAt: Date;
}

interface FindingRow {
  findingKey: string | null;
  title: string;
  finalCategory: string;
  deltaValue: string | null;
  observedValue: string | null;
}

/** The month a report is *about*: the current side of its comparison. */
function reportMonth(summary: unknown): string | null {
  if (!summary || typeof summary !== "object") return null;
  const comparison = (summary as { comparison?: { current_month?: string } }).comparison;
  return comparison?.current_month ?? null;
}

async function completedRuns(tenantIds: string[]): Promise<RunRow[]> {
  const perTenant = await Promise.all(
    tenantIds.map((tenantId) =>
      withTenant(tenantId, async (tx) => {
        const rows = await tx
          .select({ id: snapshotRun.id, summary: snapshotRun.summary, createdAt: snapshotRun.createdAt })
          .from(snapshotRun)
          .where(and(eq(snapshotRun.status, "completed"), isNotNull(snapshotRun.completedAt)))
          .orderBy(desc(snapshotRun.createdAt));
        return rows.map((r) => ({ id: r.id, tenantId, month: reportMonth(r.summary), createdAt: r.createdAt }));
      }),
    ),
  );
  return perTenant.flat();
}

async function findingsFor(tenantId: string, runId: string): Promise<FindingRow[]> {
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        findingKey: snapshotFinding.findingKey,
        title: snapshotFinding.title,
        finalCategory: snapshotFinding.finalCategory,
        deltaValue: snapshotFinding.deltaValue,
        observedValue: snapshotFinding.observedValue,
      })
      .from(snapshotFinding)
      .where(and(eq(snapshotFinding.snapshotRunId, runId), ne(snapshotFinding.findingKey, ""))),
  );
}

function outcomeOf(before: FindingRow, after: FindingRow | undefined): FindingOutcome {
  if (!after) return "resolved";
  const then = Number(before.observedValue ?? 0);
  const now = Number(after.observedValue ?? 0);
  if (now > then * 1.02) return "grew";
  if (now < then * 0.98) return "shrank";
  return "unchanged";
}

function carried(before: FindingRow, after: FindingRow | undefined, previousMonth: string | null): CarriedFinding {
  return {
    findingKey: before.findingKey ?? "",
    title: after?.title ?? before.title,
    previousCategory: before.finalCategory,
    previousMonth,
    previousDelta: before.deltaValue,
    previousCurrent: before.observedValue,
    currentDelta: after?.deltaValue ?? null,
    currentCurrent: after?.observedValue ?? null,
    outcome: outcomeOf(before, after),
  };
}

/**
 * The previous report for this customer and what became of its findings, or null when this is their
 * first snapshot (or the first since we started recording finding keys).
 */
export async function snapshotHistory(
  tenantIds: string[],
  runId: string,
  summary: unknown,
): Promise<SnapshotHistory | null> {
  const month = reportMonth(summary);
  const runs = await completedRuns(tenantIds);
  const current = runs.find((r) => r.id === runId);
  if (!current) return null;

  // The most recent report about an *earlier* month. Upload order is not billing order: someone can
  // upload August and then go back for July, and July is not news.
  const earlier = runs
    .filter((r) => r.id !== runId && r.month && (!month || r.month < month))
    .sort((a, b) => (a.month! < b.month! ? 1 : a.month! > b.month! ? -1 : b.createdAt.getTime() - a.createdAt.getTime()));
  const previous = earlier[0];
  if (!previous) return null;

  const [before, after] = await Promise.all([
    findingsFor(previous.tenantId, previous.id),
    findingsFor(current.tenantId, runId),
  ]);
  if (before.length === 0) return null; // nothing recorded to compare against

  const nowByKey = new Map(after.filter((f) => f.findingKey).map((f) => [f.findingKey!, f]));
  const thenKeys = new Set(before.map((f) => f.findingKey).filter(Boolean));

  const all = before
    .filter((f) => f.findingKey)
    .map((f) => carried(f, nowByKey.get(f.findingKey!), previous.month));

  return {
    previousRunId: previous.id,
    previousMonth: previous.month,
    carried: all.filter((f) => f.outcome !== "resolved"),
    resolved: all.filter((f) => f.outcome === "resolved"),
    newCount: after.filter((f) => f.findingKey && !thenKeys.has(f.findingKey)).length,
  };
}
