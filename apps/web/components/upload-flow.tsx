"use client";

import { type ChangeEvent, type FormEvent, useEffect, useId, useState } from "react";

const MAX_BYTES = 25 * 1024 * 1024;
const POLL_MS = 2_000;
const TERMINAL = new Set(["completed", "insufficient_data", "failed"]);

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued for processing",
  parsing: "Reading your file",
  analyzing: "Analyzing cost changes",
  classifying: "Classifying findings",
  completed: "Snapshot ready",
  insufficient_data: "Not enough data for a snapshot",
  failed: "We could not process this file",
};

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; percent: number }
  | { kind: "verifying" }
  | { kind: "processing"; runId: string; status: string }
  | { kind: "error"; message: string }
  | { kind: "manual-review-sent" };

interface Props {
  disclosure: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(payload.error ?? "Something went wrong. Please try again.");
  return payload;
}

/** PUT with progress events (fetch has no upload progress). */
function putWithProgress(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error("The upload did not complete. Please try again."));
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.send(file);
  });
}

export function UploadFlow({ disclosure }: Props) {
  const fileId = useId();
  const consentId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const busy = phase.kind === "uploading" || phase.kind === "verifying";
  const processing = phase.kind === "processing" ? phase : null;

  useEffect(() => {
    if (!processing || TERMINAL.has(processing.status)) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/snapshots/${processing.runId}`, { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as { status: string };
          setPhase({ kind: "processing", runId: processing.runId, status: body.status });
          return;
        }
      } catch {
        // transient; keep polling
      }
      setPhase({ ...processing });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [processing]);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    setFile(chosen);
    if (chosen && chosen.size > MAX_BYTES) {
      setPhase({ kind: "error", message: "The file is larger than the 25 MB limit." });
    } else if (chosen && chosen.size === 0) {
      setPhase({ kind: "error", message: "The file is empty." });
    } else {
      setPhase({ kind: "idle" });
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!file || file.size === 0 || file.size > MAX_BYTES) return;
    try {
      setPhase({ kind: "uploading", percent: 0 });
      const { upload, uploadToken } = await postJson<{
        upload: { url: string; headers: Record<string, string> };
        uploadToken: string;
      }>("/api/uploads/presign", { filename: file.name, sizeBytes: file.size });

      await putWithProgress(upload.url, upload.headers, file, (percent) =>
        setPhase({ kind: "uploading", percent }),
      );

      setPhase({ kind: "verifying" });
      const completed = await postJson<{ status: "accepted" | "rejected"; sourceFileId: string; message?: string }>(
        "/api/uploads/complete",
        { uploadToken, idempotencyKey: crypto.randomUUID(), consent: { typesafe: consent } },
      );
      if (completed.status === "rejected") {
        setPhase({ kind: "error", message: completed.message ?? "This file was not accepted." });
        return;
      }

      const { snapshotRunId } = await postJson<{ snapshotRunId: string }>("/api/snapshots", {
        sourceFileId: completed.sourceFileId,
        idempotencyKey: crypto.randomUUID(),
      });
      setPhase({ kind: "processing", runId: snapshotRunId, status: "queued" });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "Something went wrong." });
    }
  }

  async function requestManualReview() {
    try {
      await postJson("/api/pilot-requests", { manualReviewOnly: true });
      setPhase({ kind: "manual-review-sent" });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "Something went wrong." });
    }
  }

  if (phase.kind === "manual-review-sent") {
    return (
      <div role="status" className="rounded-xl border border-border bg-white p-6">
        <h2 className="text-lg font-semibold">Manual review requested</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Thanks. We will contact you by email to arrange a review. No file is needed right now.
        </p>
      </div>
    );
  }

  if (processing) {
    const done = TERMINAL.has(processing.status);
    return (
      <div role="status" aria-live="polite" className="rounded-xl border border-border bg-white p-6">
        <p className="text-sm font-medium text-accent">File accepted</p>
        <h2 className="mt-1 text-lg font-semibold">{STATUS_LABELS[processing.status] ?? "Processing"}</h2>
        {!done && <ProgressBar indeterminate label="Processing" />}
        <p className="mt-4 text-sm leading-6 text-muted">
          To keep your results private, the snapshot is shown only after you sign in. We will email a
          secure sign-in link to the address you gave us. You can close this page.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6 rounded-xl border border-border bg-white p-5 sm:p-8">
      <div className="flex flex-col gap-2">
        <label htmlFor={fileId} className="text-sm font-medium">
          AWS billing export
        </label>
        <input
          id={fileId}
          type="file"
          accept=".csv,text/csv"
          onChange={onFileChange}
          disabled={busy}
          className="block w-full text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-subtle file:px-4 file:py-2 file:font-medium"
        />
        <p className="text-xs text-muted">
          AWS Cost Explorer CSV export, UTF-8, up to 25 MB. Redacted files are fine. No AWS credentials needed.
        </p>
      </div>

      <label htmlFor={consentId} className="flex items-start gap-3 rounded-lg bg-subtle p-4 text-sm leading-6">
        <input
          id={consentId}
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          disabled={busy}
          className="mt-1 size-4 shrink-0 accent-accent"
        />
        <span>
          <strong>Allow model-assisted classification.</strong> {disclosure} Without this, you still get
          every calculated fact, and each finding is marked for human review.
        </span>
      </label>

      {phase.kind === "uploading" && <ProgressBar percent={phase.percent} label="Uploading" />}
      {phase.kind === "verifying" && <ProgressBar indeterminate label="Checking the file" />}
      <div role="status" aria-live="polite">
        {phase.kind === "error" && <p className="text-sm text-danger">{phase.message}</p>}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={!file || busy || file.size === 0 || file.size > MAX_BYTES}
          className="rounded-lg bg-accent px-5 py-3 font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Uploading…" : "Upload and analyze"}
        </button>
        <button
          type="button"
          onClick={requestManualReview}
          disabled={busy}
          className="rounded-lg px-5 py-3 text-sm font-medium text-muted underline hover:text-foreground"
        >
          Request a manual review instead
        </button>
      </div>
    </form>
  );
}

function ProgressBar({ percent, indeterminate, label }: { percent?: number; indeterminate?: boolean; label: string }) {
  return (
    <div className="mt-3">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percent}
        className="h-2 w-full overflow-hidden rounded-full bg-subtle"
      >
        <div
          className={`h-full rounded-full bg-accent transition-all ${indeterminate ? "w-1/3 animate-pulse" : ""}`}
          style={indeterminate ? undefined : { width: `${percent ?? 0}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-muted">
        {label}
        {!indeterminate && percent !== undefined ? ` · ${percent}%` : "…"}
      </p>
    </div>
  );
}
