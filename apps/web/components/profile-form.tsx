"use client";

import { CLOUD_PROVIDERS, FIRST_WAVE_COUNTRIES, SPEND_BAND_LABELS, SPEND_BANDS } from "@cca/config";
import { type FormEvent, useId, useState } from "react";

/**
 * The qualification questions, asked after the report is open rather than in front of it. Every
 * answer is optional and the report is already visible, so this is a nudge, not a gate.
 */
export function ProfileForm({ snapshotRunId }: { snapshotRunId: string }) {
  const countryId = useId();
  const providerId = useId();
  const spendId = useId();
  const problemId = useId();
  const contactId = useId();

  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (k: string) => {
      const v = String(data.get(k) ?? "").trim();
      return v === "" ? undefined : v;
    };
    setState("saving");
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          snapshotRunId,
          country: text("country"),
          provider: text("provider"),
          spendBand: text("spendBand"),
          biggestProblem: text("biggestProblem"),
          contactPermission: data.get("contactPermission") === "on",
        }),
      });
      setState(res.ok ? "saved" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "saved") {
    return (
      <p role="status" className="text-sm text-muted">
        Thanks — that helps us make the next snapshot more useful to you.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Select id={countryId} name="country" label="Where are you based?">
          {FIRST_WAVE_COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </Select>
        <Select id={providerId} name="provider" label="Primary cloud">
          {CLOUD_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
        <Select id={spendId} name="spendBand" label="Monthly cloud spend">
          {SPEND_BANDS.map((b) => (
            <option key={b} value={b}>
              {SPEND_BAND_LABELS[b]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={problemId} className="text-sm font-medium">
          What is your biggest cloud cost problem right now?
        </label>
        <textarea
          id={problemId}
          name="biggestProblem"
          rows={3}
          maxLength={1000}
          className="rounded-lg border border-border bg-white px-3 py-2 text-sm"
        />
      </div>
      <label htmlFor={contactId} className="flex items-start gap-3 text-sm leading-6">
        <input
          id={contactId}
          name="contactPermission"
          type="checkbox"
          defaultChecked
          className="mt-1 size-4 shrink-0 accent-accent"
        />
        <span>You may contact me about this snapshot.</span>
      </label>
      <div role="status" aria-live="polite">
        {state === "error" && <p className="text-sm text-danger">That did not save. Please try again.</p>}
      </div>
      <button
        type="submit"
        disabled={state === "saving"}
        className="rounded-lg border border-border bg-white px-4 py-2 text-sm font-semibold hover:bg-subtle disabled:opacity-50"
      >
        {state === "saving" ? "Saving…" : "Send answers"}
      </button>
    </form>
  );
}

function Select({
  id,
  name,
  label,
  children,
}: {
  id: string;
  name: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        name={name}
        defaultValue=""
        className="rounded-lg border border-border bg-white px-3 py-2 text-sm"
      >
        <option value="">Prefer not to say</option>
        {children}
      </select>
    </div>
  );
}
