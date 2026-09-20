import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { DeleteFileButton } from "@/components/admin-controls";
import { FindingCard } from "@/components/finding-card";
import { ManualReviewButton } from "@/components/manual-review-button";
import { ProfileForm } from "@/components/profile-form";
import { money, monthLabel, pct } from "@/lib/format";
import { profileIncomplete } from "@/lib/profile";
import { markReportViewed } from "@/lib/snapshots";
import { getSnapshotDetail, type SnapshotDetail } from "@/lib/snapshot-detail";
import { sourceFileForRun } from "@/lib/source-files";
import { tenantForViewer } from "@/lib/snapshots";
import { getViewer } from "@/lib/viewer";

const STATUS_TEXT: Record<string, string> = {
  queued: "Queued for processing",
  parsing: "Reading your file",
  analyzing: "Analyzing cost changes",
  classifying: "Classifying findings",
  completed: "Snapshot ready",
  insufficient_data: "Not enough data for a snapshot",
  failed: "We could not process this file",
};

const LIMITATIONS = [
  "AWS-first: this snapshot covers the uploaded AWS billing export only.",
  "Billing exports are not real-time.",
  "Billing data alone cannot prove that resizing or deleting anything is safe.",
  "This is decision support, not an automated action. Nothing in your AWS accounts was changed.",
  "Amounts are changes in spend, not guaranteed savings.",
  "Missing utilization, ownership or environment data leads to evidence requests, not conclusions.",
];

function modelLabel(d: SnapshotDetail): string | null {
  if (!d.modelProvider) return null;
  if (d.modelProvider === "mock") return "Test classifier (not a real model)";
  if (d.modelProvider === "typesafe") return `TypeSafe Jev (${d.modelIdentifier})`;
  return `${d.modelProvider} (${d.modelIdentifier})`;
}

function classificationNote(d: SnapshotDetail): string {
  const label = modelLabel(d);
  if (label) return `Findings were classified with ${label}; our rules made the final call.`;
  if (d.consentBasis !== "typesafe:granted") {
    return "You did not allow model-assisted classification, so every finding is rule-based and marked for human review.";
  }
  return "Model-assisted classification did not run, so every finding is rule-based and marked for human review.";
}

export default async function SnapshotPage({ params }: PageProps<"/snapshot/[id]">) {
  const { id } = await params;
  const viewer = await getViewer(await headers());
  if (!viewer) redirect(`/login?next=${encodeURIComponent(`/snapshot/${id}`)}`);
  if (!z.uuid().safeParse(id).success) notFound();

  const tenantId = await tenantForViewer(viewer, id);
  const d = tenantId ? await getSnapshotDetail(tenantId, id) : null;
  if (!d) notFound(); // another workspace's snapshot is indistinguishable from a missing one

  const owned = viewer.tenantIds.includes(tenantId!);
  // Opening this page means the emailed one-time link was used, so the address is now proven.
  // Admins looking at someone else's report must not stamp it as viewed by its owner.
  if (owned) await markReportViewed(tenantId!, id, viewer.email);
  const askProfile = owned && (await profileIncomplete(tenantId!));

  const fileId = await sourceFileForRun(tenantId!, id);
  const s = d.summary;
  const cur = s?.currency ?? null;
  const done = d.completedAt !== null;
  const failure = d.issues.find((i) => i.severity === "error");

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <p className="text-sm text-muted">
        Signed in as {viewer.email}
        {viewer.isAdmin && " · admin"} ·{" "}
        <Link href="/snapshots" className="underline">
          All snapshots
        </Link>
      </p>
      <h1 className="mt-2 text-3xl font-semibold">Cloud Cost Decision Snapshot</h1>
      <p className="mt-1 text-sm break-words text-muted">
        {d.filename}
        {s?.period.start && s.period.end && ` · ${s.period.start} to ${s.period.end}`}
      </p>

      <section className="mt-6 rounded-xl border border-border p-5" aria-label="Status">
        <p className="text-lg font-semibold">{STATUS_TEXT[d.status] ?? d.status}</p>
        {failure && (d.status === "failed" || d.status === "insufficient_data") && (
          <p className="mt-2 text-sm text-danger">{failure.message}</p>
        )}
        {!done && <p className="mt-2 text-sm text-muted">This page updates when you reload it.</p>}
        {done && d.status === "completed" && <p className="mt-2 text-sm text-muted">{classificationNote(d)}</p>}
      </section>

      {s && (
        <section className="mt-8" aria-labelledby="facts-heading">
          <h2 id="facts-heading" className="text-xl font-semibold">
            The numbers <span className="text-sm font-normal text-muted">· calculated from your file</span>
          </h2>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Spend covered" value={money(s.total, cur)} />
            <Stat
              label={
                s.comparison
                  ? `Change, ${monthLabel(s.comparison.baseline_month)} → ${monthLabel(s.comparison.current_month)}`
                  : "Month-over-month change"
              }
              value={s.comparison ? `${money(s.comparison.delta, cur)} (${pct(s.comparison.delta_pct)})` : "Not comparable"}
            />
            <Stat label="Data readiness" value={`${s.readiness.score} / 100`} />
            <Stat label="Rows read" value={`${d.rows.accepted ?? 0} of ${d.rows.seen ?? 0}`} />
          </dl>

          <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold">Monthly totals</h3>
              <table className="mt-2 w-full text-sm">
                <tbody>
                  {s.months.map((m) => (
                    <tr key={m.month} className="border-b border-border">
                      <td className="py-1.5">{monthLabel(m.month)}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(m.total, cur)}</td>
                      <td className="py-1.5 pl-3 text-right text-xs text-muted">{m.complete ? "" : "partial"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h3 className="text-sm font-semibold">Top {s.dimension_label.toLowerCase()} by cost</h3>
              <ol className="mt-2 space-y-1.5 text-sm">
                {s.top_items.map((t) => (
                  <li key={t.label} className="flex justify-between gap-3 border-b border-border pb-1.5">
                    <span className="min-w-0 break-words">{t.label}</span>
                    <span className="shrink-0 tabular-nums">
                      {money(t.cost, cur)} <span className="text-xs text-muted">{pct(t.share)}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          {s.data_gaps.length > 0 && (
            <div className="mt-6 rounded-lg bg-subtle p-4 text-sm">
              <h3 className="font-semibold">What this file cannot show</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
                {s.data_gaps.map((g) => (
                  <li key={g.code}>{g.message}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {d.findings.length > 0 && (
        <section className="mt-10" aria-labelledby="findings-heading">
          <h2 id="findings-heading" className="text-xl font-semibold">
            Decisions{" "}
            <span className="text-sm font-normal text-muted">
              · {d.findings.length} finding{d.findings.length === 1 ? "" : "s"}, ranked
            </span>
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Every finding below needs a person to confirm it before anyone acts. A bill can show what
            moved; it cannot show whether a change was intended, who owns it, or whether anything is
            safe to alter. Where a finding needs more care than that, it says so at the bottom of its
            card.
          </p>
          <div className="mt-4 space-y-6">
            {d.findings.map((f) => (
              <FindingCard key={f.evidenceId} finding={f} modelLabel={modelLabel(d)} />
            ))}
          </div>
        </section>
      )}

      {done && d.status === "completed" && d.findings.length === 0 && (
        <p className="mt-10 rounded-lg bg-subtle p-4 text-sm">
          No change met the provisional thresholds
          {s ? ` (at least ${money(s.thresholds.material_absolute, cur)} a month, or +20%)` : ""}. Nothing needs a
          decision this month.
        </p>
      )}

      {askProfile && (
        <section className="mt-10 rounded-xl border border-border p-5" aria-labelledby="profile-heading">
          <h2 id="profile-heading" className="font-semibold">
            Three quick questions <span className="text-sm font-normal text-muted">· optional</span>
          </h2>
          <p className="mt-1 text-sm text-muted">
            Your report is above and stays yours either way. These answers help us judge what to build next.
          </p>
          <ProfileForm snapshotRunId={id} />
        </section>
      )}

      {owned && done && (
        <section className="mt-10 rounded-xl border border-border p-5" aria-labelledby="review-heading">
          <h2 id="review-heading" className="font-semibold">
            Want a person to go through this with you?
          </h2>
          <p className="mt-1 mb-3 text-sm text-muted">
            We will read the snapshot with you and say what we would investigate first. No changes are made
            to your AWS accounts.
          </p>
          <ManualReviewButton snapshotRunId={id} />
        </section>
      )}

      {fileId && (
        <section className="mt-10 rounded-xl border border-border p-5 text-sm" aria-label="Your data">
          <h2 className="font-semibold">Your data</h2>
          <p className="mt-1 text-muted">
            The raw file is kept for 30 days unless you delete it sooner. Deleting removes the file, this snapshot and
            all findings.
          </p>
          <div className="mt-3">
            <DeleteFileButton sourceFileId={fileId} redirectTo="/snapshots" />
          </div>
        </section>
      )}

      <section className="mt-10 border-t border-border pt-6 text-xs text-muted" aria-label="Known limitations">
        <h2 className="font-semibold text-foreground">Known limitations</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {LIMITATIONS.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {s?.thresholds.provisional && (
          <p className="mt-2">Materiality thresholds are provisional and not tailored to your company yet.</p>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-subtle px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
