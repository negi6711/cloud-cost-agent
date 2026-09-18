import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { listSnapshots } from "@/lib/snapshots";
import { getViewer } from "@/lib/viewer";

export default async function SnapshotsPage() {
  const viewer = await getViewer(await headers());
  if (!viewer) redirect("/login?next=/snapshots");
  const runs = await listSnapshots(viewer.tenantIds);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6">
      <p className="text-sm text-muted">Signed in as {viewer.email}</p>
      <h1 className="mt-2 text-3xl font-semibold">Your snapshots</h1>
      {runs.length === 0 ? (
        <p className="mt-8 text-muted">
          No snapshots yet. <Link href="/#get-snapshot" className="text-accent underline">Start one</Link>.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-border rounded-xl border border-border">
          {runs.map((r) => (
            <li key={r.id}>
              <Link href={`/snapshot/${r.id}`} className="flex flex-wrap justify-between gap-2 px-5 py-4 hover:bg-subtle">
                <span className="font-medium">{r.filename}</span>
                <span className="text-sm text-muted">
                  {r.status} · {r.createdAt.toISOString().slice(0, 10)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
