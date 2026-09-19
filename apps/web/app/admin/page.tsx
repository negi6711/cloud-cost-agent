import { SPEND_BAND_LABELS, type SpendBand } from "@cca/config";
import { LEAD_STATUS_LABELS } from "@cca/domain";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { listLeads } from "@/lib/admin";
import { getViewer } from "@/lib/viewer";

/** Founder queue: newest leads first. Signed-in non-admins get a 404, not a hint that this exists. */
export default async function AdminPage() {
  const viewer = await getViewer(await headers());
  if (!viewer) redirect("/login?next=/admin");
  if (!viewer.isAdmin) notFound();
  const leads = await listLeads();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
      <p className="text-sm text-muted">Admin · {viewer.email}</p>
      <h1 className="mt-1 text-2xl font-semibold">Lead queue</h1>
      <p className="mt-1 text-sm text-muted">{leads.length} lead{leads.length === 1 ? "" : "s"}, newest first.</p>

      <div className="mt-6 overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-subtle text-xs text-muted uppercase">
            <tr>
              <th className="px-3 py-2">Received</th>
              <th className="px-3 py-2">Lead</th>
              <th className="px-3 py-2">Role · country</th>
              <th className="px-3 py-2">Spend band</th>
              <th className="px-3 py-2">Uploads</th>
              <th className="px-3 py-2">Latest snapshot</th>
              <th className="px-3 py-2">Requests</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} className="border-t border-border align-top">
                <td className="px-3 py-2 whitespace-nowrap">{l.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                <td className="px-3 py-2">
                  <Link href={`/admin/leads/${l.id}`} className="font-medium text-accent underline">
                    {l.companyName}
                  </Link>
                  <div className="text-xs text-muted">
                    {l.firstName} · {l.email} · {l.companyDomain}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {l.role} · {l.country}
                </td>
                <td className="px-3 py-2">{SPEND_BAND_LABELS[l.spendBand as SpendBand] ?? l.spendBand}</td>
                <td className="px-3 py-2">{l.uploads}</td>
                <td className="px-3 py-2">{l.latestRun?.status ?? "—"}</td>
                <td className="px-3 py-2 text-xs">
                  {l.pilotRequests > 0 && <span className="mr-1 rounded bg-emerald-100 px-1.5 py-0.5">pilot</span>}
                  {l.manualReview && <span className="rounded bg-amber-100 px-1.5 py-0.5">manual review</span>}
                </td>
                <td className="px-3 py-2">{LEAD_STATUS_LABELS[l.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
