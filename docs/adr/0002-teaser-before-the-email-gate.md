# ADR 0002: The deterministic teaser comes before the email gate

Status: accepted (2026-09-20). Supersedes the "form → upload → email" order in
`docs/product-spec.md` §3 and §6; everything else in that spec still holds.

## Context

MVP 0 originally asked for a full qualification form (email, website, role, country, provider, spend
band, problem) before a visitor could upload anything. That order asks a stranger to identify
themselves before we have shown them a single fact about their own bill, which costs us uploads and
gives us leads who have seen nothing.

Every headline number in the snapshot is arithmetic over the uploaded file: total spend covered, the
month-over-month change and its percentage, the largest movements, and the sum of the material
increases. None of it needs a model, and the model is the only expensive part of a run.

## Decision

1. **Upload is anonymous.** The first presign creates an empty workspace ("Unclaimed upload") and
   sets a signed, httpOnly 24h visitor cookie (`cca_visitor`, `apps/web/lib/visitor-session.ts`).
   It is not a login: it grants the teaser for files uploaded in that workspace, nothing else.
2. **A run has two phases.** The run is created with `consent_basis = 'pending'`, which makes every
   model provider unavailable (`AWAITING_UNLOCK`), so the deterministic phase parses, validates,
   analyzes and writes findings without any external call. `GET /api/snapshots/[id]` then returns a
   teaser projection: headline numbers only, never finding text, owner, next action or model output.
3. **The email gate sits under the teaser.** `POST /api/leads` takes work email, first name, company
   name, an optional role, a required permission to process the upload and email the report, and an
   optional consent to model-assisted classification. It claims the workspace, backfills
   `source_file.lead_id`, records consent, sets `unlocked_at`, and enqueues
   `snapshot.process:<run>:full` with `phase = "full"` — the only phase that may call Jev.
4. **The report stays behind a verified address.** Unlocking emails a one-time magic link; opening it
   stamps `lead.email_verified_at` and `snapshot_run.viewed_at`. The visitor cookie alone never opens
   a report.
5. **Qualification moves after the report** (`POST /api/profile`, behind the signed-in session):
   country, provider, spend band, biggest problem, contact permission. All optional.
6. **Abandoned uploads expire sooner.** A file with no lead is deleted after
   `ANONYMOUS_FILE_RETENTION_DAYS` (7); a claimed file keeps the 30-day window.

## Wording rule for the teaser

The teaser's third figure is the sum of the material month-over-month increases. It is money that
**moved**, not money anyone can recover, and the copy says so: "Cost impact to investigate", with a
note that billing data alone cannot prove a saving and that any estimate is provisional,
evidence-dependent and not guaranteed. The page must never say the reader "can save" an amount;
`apps/web/e2e/upload.spec.ts` asserts this.

## Consequences

- Nothing external sees a file before the gate, which strengthens the consent story rather than
  weakening it: the deterministic pass is local by construction, not by policy.
- Leads arrive having already seen their own numbers, so the answers we ask for afterwards are worth
  more than the ones we used to demand up front.
- Two jobs per unlocked run instead of one. Findings and evidence packets are upserted so the full
  phase updates the teaser's rows in place rather than duplicating them.
- Uploads that are never claimed still cost storage for up to 7 days.
