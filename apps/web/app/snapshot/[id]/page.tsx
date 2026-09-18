import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import {
  findViewableSnapshot,
  getSnapshotStatus,
  type SnapshotStatus,
  snapshotTenantForAdmin,
} from "@/lib/snapshots";
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

export default async function SnapshotPage({ params }: PageProps<"/snapshot/[id]">) {
  const { id } = await params;
  const viewer = await getViewer(await headers());
  if (!viewer) redirect(`/login?next=${encodeURIComponent(`/snapshot/${id}`)}`);
  if (!z.uuid().safeParse(id).success) notFound();

  let status: SnapshotStatus | null = (await findViewableSnapshot(viewer.tenantIds, id))?.status ?? null;
  if (!status && viewer.isAdmin) {
    const tenantId = await snapshotTenantForAdmin(id);
    status = tenantId ? await getSnapshotStatus(tenantId, id) : null;
  }
  // Another workspace's snapshot is indistinguishable from a missing one.
  if (!status) notFound();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6">
      <p className="text-sm text-muted">
        Signed in as {viewer.email}
        {viewer.isAdmin && " · admin"}
      </p>
      <h1 className="mt-2 text-3xl font-semibold">Cloud Cost Decision Snapshot</h1>
      <section className="mt-8 rounded-xl border border-border p-6">
        <p className="text-sm font-medium text-accent">Status</p>
        <p className="mt-1 text-lg font-semibold">{STATUS_TEXT[status.status] ?? status.status}</p>
        {!status.completed && (
          <p className="mt-2 text-sm text-muted">This page updates when you reload it.</p>
        )}
        {status.completed && status.status === "completed" && (
          <p className="mt-2 text-sm text-muted">Findings appear here once analysis is available.</p>
        )}
      </section>
      <Link href="/snapshots" className="mt-6 inline-block text-sm text-accent underline">
        All your snapshots
      </Link>
    </main>
  );
}
