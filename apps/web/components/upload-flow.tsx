"use client";

import { ROLES } from "@cca/config";
import { type ChangeEvent, type FormEvent, useEffect, useId, useState } from "react";

import { money, monthLabel, pct } from "@/lib/format";

const MAX_BYTES = 25 * 1024 * 1024;
const POLL_MS = 2_000;
const TERMINAL = new Set(["completed", "insufficient_data", "failed"]);
/** How long a queued run may sit before we stop saying "under a minute" and say what is happening. */
const SLOW_AFTER_MS = 45_000;

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued for processing",
  parsing: "Reading your file",
  analyzing: "Calculating the facts",
  classifying: "Preparing your report",
  completed: "Your figures are ready",
  insufficient_data: "Not enough data for a snapshot",
  failed: "We could not process this file",
};

export interface Teaser {
  currency: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  totalCovered: string;
  baselineMonth: string | null;
  currentMonth: string | null;
  change: string | null;
  changePct: string | null;
  topDriver: { label: string; change: string } | null;
  investigationImpact: string;
  findingCount: number;
  readinessScore: number | null;
}

interface StatusBody {
  status: string;
  message: string | null;
  warningCount: number;
  rowsAccepted: number | null;
  teaser: Teaser | null;
}

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; percent: number }
  | { kind: "verifying" }
  | {
      kind: "processing";
      runId: string;
      status: string;
      startedAt: number;
      /** Set by the poll once this has been waiting longer than a cold start should take. */
      slow?: boolean;
      message?: string | null;
      teaser?: Teaser | null;
    }
  | { kind: "unlocked"; email: string }
  | { kind: "error"; message: string };

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
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const busy = phase.kind === "uploading" || phase.kind === "verifying";
  const processing = phase.kind === "processing" ? phase : null;

  useEffect(() => {
    if (!processing || TERMINAL.has(processing.status)) return;
    const timer = setTimeout(async () => {
      // Elapsed time belongs here rather than in render: the poll is what makes it change.
      const slow = Date.now() - processing.startedAt > SLOW_AFTER_MS;
      try {
        const res = await fetch(`/api/snapshots/${processing.runId}`, { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as StatusBody;
          setPhase({
            kind: "processing",
            runId: processing.runId,
            status: body.status,
            startedAt: processing.startedAt,
            slow,
            message: body.message,
            teaser: body.teaser,
          });
          return;
        }
      } catch {
        // transient; keep polling
      }
      setPhase({ ...processing, slow });
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
        { uploadToken, idempotencyKey: crypto.randomUUID() },
      );
      if (completed.status === "rejected") {
        setPhase({ kind: "error", message: completed.message ?? "This file was not accepted." });
        return;
      }

      const { snapshotRunId } = await postJson<{ snapshotRunId: string }>("/api/snapshots", {
        sourceFileId: completed.sourceFileId,
        idempotencyKey: crypto.randomUUID(),
      });
      setPhase({ kind: "processing", runId: snapshotRunId, status: "queued", startedAt: Date.now() });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "Something went wrong." });
    }
  }

  if (phase.kind === "unlocked") {
    return (
      <div role="status" className="rounded-xl border border-border bg-white p-6">
        <h2 className="text-lg font-semibold">Check your email</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          We sent a one-time link to <strong>{phase.email}</strong>. Opening it confirms the address is
          yours and shows your full report. Your report is being prepared now; it is usually ready by
          the time the email arrives. You can close this page.
        </p>
      </div>
    );
  }

  if (processing) {
    const failed = processing.status === "failed" || processing.status === "insufficient_data";
    if (failed) {
      return (
        <div role="status" aria-live="polite" className="rounded-xl border border-border bg-white p-6">
          <p className="text-sm font-medium text-muted">Upload received</p>
          <h2 className="mt-1 text-lg font-semibold">{STATUS_LABELS[processing.status] ?? "Processing"}</h2>
          {processing.message && <p className="mt-3 text-sm text-danger">{processing.message}</p>}
          <button
            type="button"
            onClick={() => setPhase({ kind: "idle" })}
            className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground"
          >
            Upload a different file
          </button>
        </div>
      );
    }
    if (processing.status === "completed" && processing.teaser) {
      return (
        <TeaserPanel
          teaser={processing.teaser}
          disclosure={disclosure}
          onUnlocked={(email) => setPhase({ kind: "unlocked", email })}
        />
      );
    }
    // A screen that looks the same after fifteen seconds and fifteen minutes teaches people to
    // wait for something that may never arrive.
    const stalled = processing.status === "queued" && processing.slow === true;
    return (
      <div role="status" aria-live="polite" className="rounded-xl border border-border bg-white p-6">
        <p className="text-sm font-medium text-accent">File accepted</p>
        <h2 className="mt-1 text-lg font-semibold">{STATUS_LABELS[processing.status] ?? "Processing"}</h2>
        <ProgressBar indeterminate label="Processing" />
        <p className="mt-4 text-sm leading-6 text-muted">
          {stalled
            ? "This is taking longer than usual: the processor may be starting up. This page keeps checking, and your file is safe in the queue either way."
            : "We are calculating your figures from the file itself. This usually takes under a minute."}
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

      {phase.kind === "uploading" && <ProgressBar percent={phase.percent} label="Uploading" />}
      {phase.kind === "verifying" && <ProgressBar indeterminate label="Checking the file" />}
      <div role="status" aria-live="polite">
        {phase.kind === "error" && <p className="text-sm text-danger">{phase.message}</p>}
      </div>

      <button
        type="submit"
        disabled={!file || busy || file.size === 0 || file.size > MAX_BYTES}
        className="rounded-lg bg-accent px-5 py-3 font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Uploading…" : "Analyze my bill"}
      </button>
      <p className="text-xs leading-5 text-muted">
        No email needed to see your headline figures. We ask for one only when you want the full report.
      </p>
    </form>
  );
}

/**
 * The teaser: figures calculated from the file itself, shown before any email is asked for, plus the
 * gate. Every number here is arithmetic over the uploaded rows — no model has seen this file yet.
 *
 * Wording rule: this panel must never say the reader "can save" anything. A billing export shows
 * what money moved, not what money is recoverable.
 */
function TeaserPanel({
  teaser,
  disclosure,
  onUnlocked,
}: {
  teaser: Teaser;
  disclosure: string;
  onUnlocked: (email: string) => void;
}) {
  const emailId = useId();
  const firstNameId = useId();
  const companyId = useId();
  const roleId = useId();
  const processingId = useId();
  const typesafeId = useId();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [typesafeConsent, setTypesafeConsent] = useState(true);

  const currency = teaser.currency;
  const rising = teaser.change !== null && Number(teaser.change) > 0;
  const impact = Number(teaser.investigationImpact) > 0 ? teaser.investigationImpact : null;
  // Without two consecutive complete months there is nothing to compare, and saying "none material"
  // would read as "nothing to worry about" when the truth is "we could not check".
  const comparable = teaser.change !== null && teaser.baselineMonth !== null && teaser.currentMonth !== null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          firstName: form.get("firstName"),
          companyName: form.get("companyName"),
          role: form.get("role") || undefined,
          processingConsent: form.get("processingConsent") === "on",
          typesafeConsent: form.get("typesafeConsent") === "on",
          faxNumber: form.get("faxNumber") ?? "",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        fieldErrors?: Record<string, string[]>;
      };
      if (!res.ok) {
        setFieldErrors(body.fieldErrors ?? {});
        setError(body.error ?? "Something went wrong. Please try again.");
        return;
      }
      onUnlocked(email);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="teaser-heading" className="rounded-xl border border-border bg-white p-5 sm:p-8">
        <p className="text-sm font-medium text-accent">Calculated from your file</p>
        <h2 id="teaser-heading" className="mt-1 text-2xl font-semibold">
          {comparable ? (
            <>
              Your spend {rising ? "increased" : "changed"} by {money(teaser.change, currency)}
              {teaser.changePct ? ` (${pct(teaser.changePct)})` : ""} in {monthLabel(teaser.currentMonth!)}
            </>
          ) : (
            <>{money(teaser.totalCovered, currency)} of spend analyzed</>
          )}
        </h2>
        <p className="mt-2 text-sm text-muted">
          {comparable ? (
            <>Compared with {monthLabel(teaser.baselineMonth!)}, the previous comparable period in your file.</>
          ) : (
            <>
              This export does not contain two consecutive complete months, so there is nothing to compare
              it against yet. Export at least two full months to see what changed.
            </>
          )}
        </p>

        <dl className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg bg-subtle p-4">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">Spend covered</dt>
            <dd className="mt-1 text-lg font-semibold">{money(teaser.totalCovered, currency)}</dd>
          </div>
          <div className="rounded-lg bg-subtle p-4">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">Largest driver</dt>
            <dd className="mt-1 text-lg font-semibold">
              {!comparable ? (
                "Needs two complete months"
              ) : teaser.topDriver ? (
                <>
                  {teaser.topDriver.label}{" "}
                  <span className="whitespace-nowrap">+{money(teaser.topDriver.change, currency)}</span>
                </>
              ) : (
                "No single dominant driver"
              )}
            </dd>
          </div>
          <div className="rounded-lg bg-subtle p-4">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">
              Cost impact to investigate
            </dt>
            <dd className="mt-1 text-lg font-semibold">
              {!comparable ? "Not calculated" : impact ? `Up to ${money(impact, currency)}` : "None material"}
            </dd>
          </div>
        </dl>

        <p className="mt-4 text-xs leading-5 text-muted">
          &ldquo;Cost impact to investigate&rdquo; is the total of the increases we found in this file. It
          is money that moved, not money you can necessarily recover. Billing data alone cannot prove a
          saving: any estimate here is provisional, depends on evidence we cannot see in a bill, and is
          not guaranteed.
        </p>
      </section>

      <section aria-labelledby="unlock-heading" className="rounded-xl border border-border bg-white p-5 sm:p-8">
        <h2 id="unlock-heading" className="text-lg font-semibold">
          Unlock my full decision report
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          The full report names {teaser.findingCount === 1 ? "the change" : `all ${teaser.findingCount} changes`}{" "}
          we found, the evidence behind each one, who should look at it, and the next step to take. Findings
          are classified with model assistance; every figure stays the arithmetic you see above.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id={firstNameId} name="firstName" label="First name" errors={fieldErrors.firstName} required />
            <Field
              id={companyId}
              name="companyName"
              label="Company name"
              errors={fieldErrors.companyName}
              required
            />
          </div>
          <Field
            id={emailId}
            name="email"
            type="email"
            label="Work email"
            hint="We send your report to this address."
            errors={fieldErrors.email}
            required
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={roleId} className="text-sm font-medium">
              Your role <span className="font-normal text-muted">(optional)</span>
            </label>
            <select
              id={roleId}
              name="role"
              defaultValue=""
              className="rounded-lg border border-border bg-white px-3 py-2 text-sm"
            >
              <option value="">Prefer not to say</option>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </div>

          <label htmlFor={processingId} className="flex items-start gap-3 rounded-lg bg-subtle p-4 text-sm leading-6">
            <input
              id={processingId}
              name="processingConsent"
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-accent"
            />
            <span>
              I agree that you may process the billing export I uploaded to produce my report, and email
              that report to me.
              {fieldErrors.processingConsent && (
                <span className="mt-1 block text-danger">{fieldErrors.processingConsent[0]}</span>
              )}
            </span>
          </label>

          <label htmlFor={typesafeId} className="flex items-start gap-3 rounded-lg bg-subtle p-4 text-sm leading-6">
            <input
              id={typesafeId}
              name="typesafeConsent"
              type="checkbox"
              checked={typesafeConsent}
              onChange={(e) => setTypesafeConsent(e.target.checked)}
              className="mt-1 size-4 shrink-0 accent-accent"
            />
            <span>
              <strong>Allow model-assisted classification.</strong> {disclosure} Without this, you still get
              every calculated fact, and each finding is marked for human review.
            </span>
          </label>

          {/* Honeypot: hidden from people, filled by naive bots. */}
          <div aria-hidden="true" className="hidden">
            <label htmlFor="fax-number">Fax number</label>
            <input id="fax-number" name="faxNumber" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
          </div>

          <div role="status" aria-live="polite">
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-accent px-5 py-3 font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-50 sm:w-auto"
          >
            {submitting ? "Sending…" : "Unlock my full decision report"}
          </button>
          <p className="text-xs leading-5 text-muted">
            We email a one-time link instead of asking for a password, so your report stays private to the
            address you enter.
          </p>
        </form>
      </section>
    </div>
  );
}

function Field({
  id,
  name,
  label,
  type = "text",
  hint,
  errors,
  required,
}: {
  id: string;
  name: string;
  label: string;
  type?: string;
  hint?: string;
  errors?: string[];
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        autoComplete={name === "email" ? "email" : name === "firstName" ? "given-name" : "organization"}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="rounded-lg border border-border bg-white px-3 py-2 text-sm"
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {errors && <p className="text-xs text-danger">{errors[0]}</p>}
    </div>
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
