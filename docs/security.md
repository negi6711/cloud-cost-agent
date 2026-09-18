# Security and data handling (MVP 0)

Status: **not production-ready.** This page records what MVP 0 does with prospect data and which
guarantees third parties do and do not give. It is updated as each control is implemented.

## What we collect

| Data | Where it lives | Sent to third parties? |
|---|---|---|
| Qualification answers (email, name, company, role, country, spend band…) | Postgres | No |
| Uploaded billing CSV (raw) | Private object storage (R2 hosted / local filesystem) | No |
| Normalized facts and findings | Postgres | No |
| Minimized evidence packet (see below) | Postgres | **TypeSafe Jev, only with consent** |
| Explanation input (Week 2) | — | **OpenAI, only when enabled and consented** |

No AWS credentials are ever requested or accepted.

## Evidence packet minimization

Before any model call the worker builds a versioned, hashed packet that contains only aggregates and
flags: billing and comparison periods, covered total and currency, per-dimension aggregates and
deltas, new/removed items, allocation completeness, data-quality warnings, candidate finding IDs and
known limitations.

- Account IDs and account names are replaced with `acct_01…`; the mapping never leaves our database.
- Tag values are pseudonymized.
- Labels from the file are treated as untrusted data: control characters stripped, truncated to 80
  characters, passed as data fields. Instructions inside uploaded content are never followed.
- No email, company name, filename, raw rows or resource IDs are sent.

## Third-party terms (verified 2026-09-18)

### TypeSafe (Jev) — MCA and DPA

- **Training:** MCA §4.1 — no customer data in training datasets without consent.
- **Transfers:** DPA §6 — EU SCCs (Modules 2/3) and the UK IDTA.
- **Breach notice:** DPA §5.2 — within 72 hours.
- **Telemetry:** MCA §4.3 permits processing of logs, hashes and summary statistics.
- **Not stated:** processing region, retention period for API inputs/outputs, deletion on request,
  specific security certifications. Zero data retention is offered to enterprise customers only.
- **No SLA.** Liability cap: the greater of 12 months' fees or USD 50 (MCA §12.2).
- **Our obligation:** MCA §5 — we must hold the rights and consents to send end-user data.

Consequences for MVP 0:

1. A packet is sent to TypeSafe only if the prospect ticked the TypeSafe consent box.
2. User-facing copy must never claim that TypeSafe deletes submitted data.
3. Deleting a snapshot removes our copies; copies already processed by TypeSafe are outside our
   control, and the disclosure says so.

## Retention (provisional defaults)

| Artifact | Default |
|---|---|
| Raw uploaded file | Deleted after 30 days (`RAW_FILE_RETENTION_DAYS`) or on request |
| Derived facts, findings, evidence packets, model-call records | Kept until the prospect or founder deletes the source file |
| Delete flow | Removes the object, runs, findings, evidence packets and model-call records; writes a content-free audit event |

## Controls checklist

Filled in as controls land; each links to its test.

- [ ] Private bucket, expiring signed URLs
- [ ] Server-side size limit, byte sniffing, no trust in extensions
- [ ] Tenant isolation (chokepoint + RLS) with cross-tenant tests
- [ ] Consent gate before external model processing
- [ ] Redacted structured logs; no file content or prompts in logs
- [ ] Model keys absent from web bundle and API responses
- [ ] Delete flow for source and derived data
