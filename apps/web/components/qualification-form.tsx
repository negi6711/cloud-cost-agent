"use client";

import {
  AWS_ACCOUNT_COUNTS,
  CLOUD_PROVIDERS,
  FIRST_WAVE_COUNTRIES,
  PILOT_INTEREST,
  ROLES,
  SPEND_BAND_LABELS,
  SPEND_BANDS,
  YES_NO_UNSURE,
} from "@cca/config";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";

type FieldErrors = Partial<Record<string, string[]>>;

const OPTIONAL_KEYS = [
  "awsAccountCount",
  "kubernetesUsage",
  "aiGpuUsage",
  "recentBillShock",
  "desiredOutcome",
  "pilotInterest",
] as const;

export function QualificationForm() {
  const router = useRouter();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFormError(null);
    setErrors({});

    const data = new FormData(event.currentTarget);
    const text = (k: string) => String(data.get(k) ?? "");
    const body: Record<string, unknown> = {
      email: text("email"),
      firstName: text("firstName"),
      companyName: text("companyName"),
      companyWebsite: text("companyWebsite"),
      role: text("role"),
      country: text("country"),
      provider: text("provider"),
      spendBand: text("spendBand"),
      biggestProblem: text("biggestProblem"),
      contactPermission: data.get("contactPermission") === "on",
      faxNumber: text("faxNumber"),
    };
    for (const key of OPTIONAL_KEYS) {
      const value = text(key);
      if (value) body[key] = value;
    }

    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        router.push("/upload");
        return;
      }
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        fieldErrors?: FieldErrors;
      };
      setErrors(payload.fieldErrors ?? {});
      setFormError(payload.error ?? "Something went wrong. Please try again.");
    } catch {
      setFormError("We could not reach the server. Check your connection and try again.");
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6" aria-describedby="form-status">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField name="email" label="Work email" type="email" autoComplete="email" errors={errors} />
        <TextField name="firstName" label="First name" autoComplete="given-name" errors={errors} />
        <TextField name="companyName" label="Company name" autoComplete="organization" errors={errors} />
        <TextField
          name="companyWebsite"
          label="Company website"
          placeholder="acme.com"
          autoComplete="url"
          errors={errors}
        />
        <SelectField name="role" label="Role" options={ROLES.map((r) => [r, r])} errors={errors} />
        <SelectField
          name="country"
          label="Country"
          options={FIRST_WAVE_COUNTRIES.map((c) => [c.code, c.label])}
          errors={errors}
        />
        <SelectField
          name="provider"
          label="Primary cloud provider"
          options={CLOUD_PROVIDERS.map((p) => [p, p])}
          errors={errors}
        />
        <SelectField
          name="spendBand"
          label="Estimated monthly cloud spend"
          options={SPEND_BANDS.map((b) => [b, SPEND_BAND_LABELS[b]])}
          errors={errors}
        />
      </div>

      <TextAreaField
        name="biggestProblem"
        label="Biggest current cloud-cost problem"
        placeholder="e.g. Our AWS bill rose 30% last month and nobody knows which team caused it."
        errors={errors}
      />

      <details className="rounded-lg border border-border px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium">More context (optional)</summary>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            name="awsAccountCount"
            label="Number of AWS accounts"
            options={AWS_ACCOUNT_COUNTS.map((v) => [v, v])}
            optional
            errors={errors}
          />
          <SelectField
            name="kubernetesUsage"
            label="Kubernetes in use?"
            options={YES_NO_UNSURE.map((v) => [v, v])}
            optional
            errors={errors}
          />
          <SelectField
            name="aiGpuUsage"
            label="AI / GPU workloads?"
            options={YES_NO_UNSURE.map((v) => [v, v])}
            optional
            errors={errors}
          />
          <SelectField
            name="pilotInterest"
            label="Could a 30-day paid pilot be relevant?"
            options={PILOT_INTEREST.map((v) => [v, v])}
            optional
            errors={errors}
          />
          <TextAreaField name="recentBillShock" label="Recent bill shock" optional errors={errors} />
          <TextAreaField name="desiredOutcome" label="Desired result" optional errors={errors} />
        </div>
      </details>

      {/* Honeypot: invisible to people and assistive tech; bots tend to fill it. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>
          Fax number
          <input name="faxNumber" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <CheckboxField
        name="contactPermission"
        label="You may contact me about my snapshot and a possible pilot."
        errors={errors}
      />

      <div id="form-status" role="status" aria-live="polite">
        {formError && <p className="text-sm text-danger">{formError}</p>}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-accent px-5 py-3 font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-60 sm:w-auto"
      >
        {pending ? "Saving…" : "Continue to upload"}
      </button>
      <p className="text-xs text-muted">
        Next step: upload an AWS Cost Explorer CSV, or ask for a manual review instead.
      </p>
    </form>
  );
}

// ------------------------------------------------------------------ fields ---

interface FieldProps {
  name: string;
  label: string;
  errors: FieldErrors;
  optional?: boolean;
}

function FieldShell({
  id,
  label,
  optional,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {optional && <span className="font-normal text-muted"> (optional)</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const inputClass =
  "rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 aria-[invalid=true]:border-danger";

function TextField({
  name,
  label,
  errors,
  optional,
  type = "text",
  placeholder,
  autoComplete,
}: FieldProps & { type?: string; placeholder?: string; autoComplete?: string }) {
  const id = useId();
  const error = errors[name]?.[0];
  return (
    <FieldShell id={id} label={label} optional={optional} error={error}>
      <input
        id={id}
        name={name}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={!optional}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={inputClass}
      />
    </FieldShell>
  );
}

function TextAreaField({ name, label, errors, optional, placeholder }: FieldProps & { placeholder?: string }) {
  const id = useId();
  const error = errors[name]?.[0];
  return (
    <FieldShell id={id} label={label} optional={optional} error={error}>
      <textarea
        id={id}
        name={name}
        rows={3}
        placeholder={placeholder}
        required={!optional}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={inputClass}
      />
    </FieldShell>
  );
}

function SelectField({
  name,
  label,
  errors,
  optional,
  options,
}: FieldProps & { options: ReadonlyArray<readonly [string, string]> }) {
  const id = useId();
  const error = errors[name]?.[0];
  return (
    <FieldShell id={id} label={label} optional={optional} error={error}>
      <select
        id={id}
        name={name}
        defaultValue=""
        required={!optional}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={inputClass}
      >
        <option value="" disabled={!optional}>
          {optional ? "—" : "Select…"}
        </option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

function CheckboxField({ name, label, errors }: FieldProps) {
  const id = useId();
  const error = errors[name]?.[0];
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex items-start gap-3 text-sm">
        <input
          id={id}
          name={name}
          type="checkbox"
          required
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          className="mt-0.5 size-4 accent-accent"
        />
        <span>{label}</span>
      </label>
      {error && (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
