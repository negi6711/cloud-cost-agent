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

- [x] Private storage, expiring signed upload URLs bound to key + exact size — local driver tested
  (`apps/web/tests/upload-flow.test.ts`); R2 presign signs `content-length`; bucket privacy and CORS
  verified at staging setup (Day 6)
- [x] Server-side size limit, byte sniffing, no trust in extensions or declared type —
  `apps/web/lib/sniff.ts`, `apps/web/tests/sniff.test.ts`; worker re-verifies SHA-256 before use
- [x] Tenant isolation (chokepoint + RLS) with cross-tenant tests — `db/migrations/0001_*.sql`,
  `apps/web/tests/tenant-isolation.test.ts`
- [ ] Consent gate before external model processing — consent captured per upload (opt-in, never
  pre-ticked) and recorded on the run; enforcement lands with the Jev provider (Day 5)
- [x] Redacted structured logs; no file content or prompts in logs — `apps/web/lib/log.ts`,
  `worker/src/cca/logging_setup.py`
- [ ] Model keys absent from web bundle and API responses — manual bundle scan clean on Day 1;
  automated check pending
- [ ] Delete flow for source and derived data
- [x] Evidence packets minimized: account/tag values aliased, IDs and emails masked,
  instruction-like and formula labels withheld, no rule outcomes (`worker/tests/test_analysis.py`)
- [x] Billing-only data can never produce RESIZE/DELETE/STOP/BUY: category enum + DB CHECK + policy
  gate; explanations tested for destructive wording (`worker/tests/test_analysis.py`,
  `worker/tests/test_policy_gate.py`)
- [x] Results only behind email magic-link login (Better Auth): links are single-use, expire in 30
  minutes, tokens stored hashed; links are sent only to known leads or admins, and the response never
  reveals which (`apps/web/tests/auth.test.ts`, `apps/web/e2e/auth.spec.ts`)
- [x] A signed-in lead sees only their own workspaces; another lead's snapshot URL returns 404
  (`apps/web/e2e/auth.spec.ts`)
- [x] Per-IP rate limiting on sign-in and verification (disabled only when `APP_ENV=test`)
- [x] Emails carry links only, never billing content
- [x] Worker endpoint authentication — HMAC over a timestamp, 5-minute skew window, no docs/OpenAPI
  routes (`worker/tests/test_service.py`)
