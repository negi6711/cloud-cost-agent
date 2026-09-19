import { SPEND_BAND_LABELS, type SpendBand } from "@cca/config";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import {
  CopyLinkButton,
  DeleteFileButton,
  LeadStatusForm,
  NoteForm,
  ResendLinkButton,
} from "@/components/admin-controls";
import { getLeadDetail, resultUrl } from "@/lib/admin";
import { getViewer } from "@/lib/viewer";

export default async function AdminLeadPage({ params }: PageProps<"/admin/leads/[id]">) {
  const { id } = await params;
  const viewer = await getViewer(await headers());
  if (!viewer) redirect(`/login?next=${encodeURIComponent(`/admin/leads/${id}`)}`);
  if (!viewer.isAdmin || !z.uuid().safeParse(id).success) notFound();
  const detail = await getLeadDetail(id);
  if (!detail) notFound();
  const { lead: l, files, notes, pilots } = detail;

  const answers: [string, string | null][] = [
    ["Email", l.email],
    ["Company", `${l.companyName} (${l.companyDomain})`],
    ["Role", l.role],
    ["Country", l.country],
    ["Primary cloud", l.provider],
    ["Spend band", SPEND_BAND_LABELS[l.spendBand as SpendBand] ?? l.spendBand],
    ["Biggest problem", l.biggestProblem],
    ["AWS accounts", l.awsAccountCount],
    ["Kubernetes", l.kubernetesUsage],
    ["AI / GPU", l.aiGpuUsage],
    ["Recent bill shock", l.recentBillShock],
    ["Desired result", l.desiredOutcome],
    ["30-day pilot relevant", l.pilotInterest],
  ];

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin" className="text-sm text-accent underline">
        ← Lead queue
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">
        {l.companyName} <span className="text-base font-normal text-muted">· {l.firstName}</span>
      </h1>
      <div className="mt-4">
        <LeadStatusForm leadId={l.id} status={l.status} />
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Qualification answers</h2>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {answers.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="break-words">{v || "—"}</dd>
            </div>
          ))}
        </dl>
      </section>

      {pilots.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Requests</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {pilots.map((p) => (
              <li key={p.id}>
                {p.createdAt.toISOString().slice(0, 10)} · {p.manualReviewOnly ? "Manual review (no file)" : "Pilot"}
                {p.preferredPrice && ` · price: ${p.preferredPrice}`}
                {p.message && ` · “${p.message}”`}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Uploads</h2>
        {files.length === 0 && <p className="mt-2 text-sm text-muted">No files uploaded.</p>}
        <div className="mt-3 space-y-6">
          {files.map((f) => (
            <article key={f.id} className="rounded-xl border border-border p-4" aria-label={`Upload ${f.originalFilename}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium break-words">{f.originalFilename}</p>
                  <p className="text-xs text-muted">
                    {f.createdAt.toISOString().slice(0, 16).replace("T", " ")} · {(f.sizeBytes / 1024).toFixed(1)} KB ·{" "}
                    {f.status}
                    {f.detectedPeriodStart && ` · ${f.detectedPeriodStart} to ${f.detectedPeriodEnd}`} · TypeSafe consent:{" "}
                    {f.typesafeConsent === null ? "n/a" : f.typesafeConsent ? "yes" : "no"}
                    {f.rawDeletedAt && " · raw file deleted (retention)"}
                  </p>
                </div>
                <DeleteFileButton sourceFileId={f.id} redirectTo={`/admin/leads/${l.id}`} />
              </div>

              {f.runs.map((r) => (
                <div key={r.id} className="mt-4 border-t border-border pt-4">
                  <p className="text-sm">
                    <Link href={`/snapshot/${r.id}`} className="font-medium text-accent underline">
                      Snapshot {r.id.slice(0, 8)}
                    </Link>{" "}
                    · {r.status} · readiness {r.dataReadinessScore ?? "—"} · {r.findings} finding
                    {r.findings === 1 ? "" : "s"} ({r.reviewRequired} need review) · model: {r.modelStatus ?? "—"}
                    {r.modelProvider && ` (${r.modelProvider} ${r.modelIdentifier})`}
                  </p>
                  {r.issues.length > 0 && (
                    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted">
                      {r.issues.map((i) => (
                        <li key={i.code}>
                          <span className="font-mono">{i.code}</span> ({i.severity}): {i.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <CopyLinkButton url={resultUrl(r.id)} />
                    <ResendLinkButton runId={r.id} />
                  </div>
                  <div className="mt-3 max-w-xl">
                    <NoteForm runId={r.id} />
                  </div>
                </div>
              ))}
            </article>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Notes</h2>
        {notes.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No notes yet.</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {notes.map((n) => (
              <li key={n.id} className="rounded-lg bg-subtle p-3">
                <p className="whitespace-pre-wrap">{n.body}</p>
                <p className="mt-1 text-xs text-muted">
                  {n.authorEmail} · {n.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
