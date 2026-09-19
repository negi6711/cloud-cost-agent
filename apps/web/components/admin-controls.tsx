"use client";

import { LEAD_STATUSES } from "@cca/config";
import { LEAD_STATUS_LABELS } from "@cca/domain";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";

async function send(url: string, method: "POST" | "DELETE", body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return null;
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    return payload.error ?? "Something went wrong.";
  } catch {
    return "Could not reach the server.";
  }
}

export function LeadStatusForm({ leadId, status }: { leadId: string; status: string }) {
  const router = useRouter();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onChange(value: string) {
    setSaving(true);
    const err = await send(`/api/admin/leads/${leadId}/status`, "POST", { status: value });
    setError(err);
    setSaving(false);
    if (!err) router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        Lead status
      </label>
      <select
        id={id}
        defaultValue={status}
        disabled={saving}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-border bg-white px-3 py-1.5 text-sm"
      >
        {LEAD_STATUSES.map((s) => (
          <option key={s} value={s}>
            {LEAD_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}

export function NoteForm({ runId }: { runId: string }) {
  const router = useRouter();
  const id = useId();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = String(new FormData(form).get("body") ?? "");
    const err = await send(`/api/admin/snapshots/${runId}/notes`, "POST", { body });
    setError(err);
    if (!err) {
      form.reset();
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        Reviewed note (internal)
      </label>
      <textarea id={id} name="body" rows={2} maxLength={2000} className="rounded-lg border border-border px-3 py-2 text-sm" />
      <div className="flex items-center gap-3">
        <button type="submit" className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-subtle">
          Add note
        </button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </form>
  );
}

export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(url).catch(() => undefined);
        setCopied(true);
      }}
      className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-subtle"
      data-url={url}
    >
      {copied ? "Link copied" : "Copy result link"}
    </button>
  );
}

export function ResendLinkButton({ runId }: { runId: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | string>("idle");
  return (
    <button
      type="button"
      disabled={state === "sending"}
      onClick={async () => {
        setState("sending");
        const err = await send(`/api/admin/snapshots/${runId}/resend-link`, "POST", {});
        setState(err ?? "sent");
      }}
      className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-subtle"
    >
      {state === "sent" ? "Sign-in link sent" : state === "idle" || state === "sending" ? "Email sign-in link" : state}
    </button>
  );
}

/** Deletes a file and everything derived from it, after an explicit confirmation. */
export function DeleteFileButton({
  sourceFileId,
  redirectTo,
  label = "Delete file and snapshot",
}: {
  sourceFileId: string;
  redirectTo: string;
  label?: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-lg border border-danger/40 px-3 py-1.5 text-sm font-medium text-danger hover:bg-rose-50"
      >
        {label}
      </button>
    );
  }
  return (
    <div role="alertdialog" aria-label="Confirm deletion" className="rounded-lg border border-danger/40 p-3 text-sm">
      <p>
        This permanently deletes the uploaded file, the snapshot and all findings. It cannot be undone. A summary
        already processed by TypeSafe cannot be recalled by us.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={async () => {
            const err = await send(`/api/source-files/${sourceFileId}`, "DELETE");
            if (err) setError(err);
            else {
              router.push(redirectTo);
              router.refresh();
            }
          }}
          className="rounded-lg bg-danger px-3 py-1.5 font-semibold text-white"
        >
          Delete permanently
        </button>
        <button type="button" onClick={() => setConfirming(false)} className="rounded-lg border border-border px-3 py-1.5">
          Cancel
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
