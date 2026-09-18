# Cloud Cost Decision Agent — MVP 0 Week 1 Specification

**Status:** Build-ready draft  
**Date:** 2026-09-18  
**Owner:** Solo founder  
**Primary builder:** Claude Code  
**Product category:** Cloud Cost Decision Agent  
**MVP 0 name:** Cloud Cost Decision Snapshot  

> **Resolved decisions (2026-09-18, founder-approved).** Where this spec conflicts with itself,
> these win. Jev-specific decisions are recorded in `docs/adr/0001-jev-integration.md`.
> - Jev is part of MVP 0 (§1, §8). §16's "Jev is not required for the deterministic MVP 0 result"
>   means the deterministic facts never depend on Jev. §17's "Jev behind a feature flag" is superseded.
> - Every table carries `tenant_id` (§9 rule), including those §10 omits.
> - Prospects view results after upload via an email magic-link login; the upload screen shows
>   validation and processing status only (§3 Flow B step 7 is superseded).
> - A Cost Explorer CSV holds one group-by dimension; account/region changes appear only when the
>   uploaded file is grouped that way.

## 0. The product in one sentence

> Upload your AWS billing data and receive a ranked Cloud Cost Decision Snapshot: what changed, why it changed, who owns it, what action is safest, what evidence is missing, and whether the decision worked after approval.

## 1. What MVP 0 is for

MVP 0 is not the full paid product and not an autonomous cloud optimizer.

Its purpose is to test whether qualified cloud-heavy software companies will:

1. understand the problem from the landing page;
2. identify themselves as having it;
3. upload real or redacted AWS billing data;
4. receive a credible first snapshot;
5. request a human-reviewed recurring pilot;
6. eventually pay for repeated decision support.

MVP 0 must provide a real upload, deterministic data-readiness experience, and a real Jev-assisted classification path. Other LLMs may be used for bounded explanation or semantic enrichment through explicit provider interfaces. It must never pretend that live AWS actions, complete rightsizing, or autonomous savings execution are available.

The user-uploaded landing-page snapshot must execute the same model-assisted classification path intended for the first pilot. Deterministic code remains authoritative for parsing, arithmetic, thresholds, policy gates, and prohibited actions; Jev supplies bounded typed classification and confidence; an optional frontier LLM supplies fact-grounded explanation only.

### MVP 0 success condition

The product is working when a qualified visitor can go from landing page to:

```text
Landing page
→ qualification form
→ upload AWS billing file
→ deterministic validation and normalization
→ Jev-assisted typed classification
→ optional LLM explanation
→ transparent Cloud Cost Decision Snapshot
→ pilot request
```

### MVP 0 does not need

- AWS credentials;
- AWS OAuth;
- direct AWS APIs;
- Slack/Jira integrations;
- multi-cloud connectors;
- autonomous actions;
- GCP/Azure support;
- Kubernetes support;
- a multi-page dashboard;
- user-configurable policy builders;
- a full FinOps data warehouse.

## 2. User and scope

### Primary ICP

English-speaking, cloud-heavy software companies with:

- approximately 20–300 employees;
- roughly $10,000–$75,000 monthly cloud spend as the central hypothesis;
- AWS as the main cloud;
- SaaS, AI, API, data, cybersecurity, marketplace, or developer-tool economics;
- a CTO, VP Engineering, Head of Platform, DevOps/SRE lead, FinOps practitioner, or ML infrastructure lead;
- no dedicated FinOps team or a small FinOps function;
- a recent cloud-cost trigger.

The fake-door test may accept $5,000–$100,000/month, but the form must record the actual band rather than assuming it from company size.

### First-wave countries

- United States
- United Kingdom
- Canada
- Singapore
- Australia
- Israel
- Ireland
- Netherlands
- Germany
- India
- Poland
- Estonia

This is a go-to-market prioritization hypothesis, not a precise country-level market-size claim. The product language remains global and English-first.

### Primary user job

> “Help me understand which cloud-cost change deserves attention and what the safest next step is, without forcing me to implement another FinOps platform.”

## 3. MVP 0 user experience

### Flow A — Visitor who does not upload

1. Visitor lands on the page.
2. Visitor sees a real sample Cloud Cost Decision Snapshot.
3. Visitor clicks **Get my free snapshot**.
4. Visitor completes the qualification form.
5. Visitor sees the upload step.
6. Visitor can upload immediately or request a manual review.
7. If no file is uploaded, the product collects a pilot request and sends a confirmation email.

### Flow B — Visitor uploads a file

1. Visitor completes qualification form.
2. Visitor uploads an AWS Cost Explorer CSV.
3. Product displays upload progress.
4. Product validates file type, size, encoding, required columns, billing period, and basic totals.
5. Product creates a `snapshot_run`.
6. Deterministic worker processes the file.
7. Product displays:
   - data-readiness status;
   - detected period;
   - estimated spend covered;
   - top services or categories;
   - largest period-over-period changes;
   - data gaps;
   - sample decision cards.
8. Product offers **Request a human-reviewed snapshot**.
9. Founder receives the file and prospect metadata in the internal admin view/email.

### Flow C — Internal founder review

1. Founder opens the admin queue.
2. Founder sees the uploaded file, qualification answers, validation warnings, and deterministic findings.
3. Founder can add a short manually reviewed note.
4. Founder marks the prospect as:
   - needs clarification;
   - snapshot sent;
   - pilot requested;
   - not qualified;
   - follow up later.
5. The prospect receives a secure result link or email.

## 4. MVP 0 landing-page copy

### Hero

**Turn your AWS bill into decisions, not dashboards.**

Upload your AWS billing data and receive a ranked Cloud Cost Decision Snapshot showing what changed, why it changed, who owns it, what action is safest, and what evidence is missing.

**Primary CTA:** Get my free Cloud Cost Decision Snapshot  
**Secondary CTA:** View an example snapshot

Trust line:

> Read-only by default. No AWS credentials required for the first review. No automatic infrastructure changes.

### Problem section

Your bill changed. Your team still has to figure out:

- what caused the change;
- whether it was intentional;
- which team owns it;
- whether the action is safe;
- what evidence is missing;
- whether the fix actually worked.

### Three-step section

1. **Upload** an AWS billing export.
2. **Understand** the highest-impact cost changes and evidence gaps.
3. **Decide** what to investigate, monitor, approve, or escalate.

### Sample snapshot

```text
REQUEST EVIDENCE

Spend change: +$1,840/month
Area: shared ECS services
Likely owner: Platform Engineering

What changed:
A new service family appeared in the latest period and represents 18% of the increase.

What we know:
- Increase is concentrated in one AWS account.
- No team allocation tag was present.
- Billing evidence confirms the change.

What is missing:
CloudWatch utilization and confirmation that the service is production-critical.

Safest next action:
Confirm owner and collect utilization evidence before considering a cost change.

Risk: Low
Status: Awaiting human review
```

### Audience section

Built for:

- SaaS engineering teams;
- AI and ML infrastructure teams;
- API and developer-tool companies;
- data-heavy software companies;
- platform, DevOps, SRE, FinOps, and technical finance teams.

Best fit:

- AWS is material to your business;
- your cloud spend changes frequently;
- nobody owns a full-time FinOps function;
- AWS Cost Explorer alone does not tell you what to do next.

### Explicit non-fit

Not for:

- tiny AWS bills with no recurring cost problem;
- teams looking for autonomous production changes;
- companies requiring GCP/Azure/Kubernetes support on day one;
- customers expecting guaranteed savings.

### FAQ

**Do you need AWS credentials?**  
No. MVP 0 accepts a redacted AWS Cost Explorer CSV. A future production connector will use a documented read-only role.

**Will the product change my infrastructure?**  
No. MVP 0 is read-only. Every consequential action will require explicit human approval.

**Is this another cloud-cost dashboard?**  
No. The intended output is a short decision snapshot with evidence, owner, risk, missing information, and next action.

**Can I upload sensitive billing data?**  
Upload only data you are permitted to share. MVP 0 should support redacted files and document retention/deletion behavior clearly before broad use.

## 5. Qualification form

Required:

- work email;
- first name;
- company name;
- company website;
- role;
- country;
- primary cloud provider;
- estimated monthly cloud spend band;
- biggest current cloud-cost problem;
- permission to contact.

Optional:

- number of AWS accounts;
- Kubernetes usage;
- AI/GPU usage;
- recent bill shock;
- desired result;
- upload file;
- whether a 30-day paid pilot is potentially relevant.

Spend bands:

- Under $5k/month;
- $5k–$10k/month;
- $10k–$25k/month;
- $25k–$75k/month;
- $75k–$100k/month;
- Over $100k/month;
- Not sure.

Do not reject low-band users automatically. Store the band and use it for qualification analysis.

## 6. MVP 0 supported files

### Supported in Week 1

- AWS Cost Explorer CSV export;
- UTF-8 CSV;
- common comma-delimited format;
- maximum upload size: 25 MB;
- at least one date/period column;
- service/category and cost columns.

### Optional if time permits

- AWS CUR 2.0 Parquet fixture;
- AWS CUR 2.0 CSV fixture.

### Explicitly unsupported in MVP 0

- screenshots as primary input;
- PDFs;
- OCR;
- CloudWatch files;
- GCP exports;
- Azure exports;
- Kubernetes exports;
- direct AWS API access;
- arbitrary Excel workbooks with formulas.

The UI should say “AWS billing export” rather than promise universal format compatibility.

## 7. Deterministic MVP 0 analysis

MVP 0 should generate observations and limited safe decision candidates. It must not pretend to provide complete rightsizing or savings optimization from billing data alone.

### Required checks

1. File type and size.
2. Encoding and delimiter detection.
3. Header detection.
4. Required cost/date/service fields.
5. Numeric parsing.
6. Negative cost and credit handling.
7. Billing period detection.
8. Partial-period warning.
9. Duplicate row detection.
10. Currency detection.
11. Total-cost calculation.
12. Service-level aggregation.
13. Period-over-period comparison when at least two periods exist.
14. Unknown/missing dimension detection.
15. Idempotent rerun.

### Required findings

- total spend covered by the file;
- date range;
- top five services by cost;
- largest positive cost changes by service;
- largest positive cost changes by account/region if available;
- new services/resources if identifiable;
- unallocated or unknown dimensions;
- materiality warnings;
- data-readiness score.

### MVP 0 materiality rules

These are initial rules, not customer-specific policies:

```text
material_change_absolute = max(500 USD/month, 5% of covered monthly spend)
material_change_relative = 20% period-over-period increase
new_service_threshold = 5% of covered period spend
unknown_allocation_threshold = 10% of covered period spend
```

The rules must be configurable in code and clearly labeled as provisional.

### MVP 0 decision categories

Use only these categories:

- INVESTIGATE;
- REQUEST EVIDENCE;
- MONITOR;
- ESCALATE.

Do not produce RESIZE, DELETE, STOP, or BUY COMMITMENT recommendations unless the necessary usage and policy evidence exists. In MVP 0, those may appear only as future actions in sample content, not as live conclusions from billing-only data.

## 8. Jev and LLM scope for MVP 0

### MVP 0 default

Jev is a dependency of the normal user-uploaded snapshot path because classification quality is part of the value being tested.

The pipeline is:

```text
deterministic parsing and aggregation
→ deterministic candidate findings
→ minimized evidence packet
→ Jev typed classification and confidence
→ optional frontier-LLM explanation/enrichment
→ deterministic policy/evidence gate
→ human-readable snapshot
```

Deterministic code remains authoritative for:

- parsing and normalization;
- totals and deltas;
- materiality thresholds;
- evidence IDs;
- prohibited action categories;
- policy gates;
- retries and idempotency;
- external actions, which do not exist in MVP 0.

Jev receives only normalized facts and evidence IDs sufficient for bounded questions. It should classify INVESTIGATE / REQUEST_EVIDENCE / MONITOR / ESCALATE and return typed owner, urgency, risk, confidence, and missing-evidence outputs where supported.

### Provider options

The implementation must compare these in Plan Mode before selecting one:

1. Jev called from the Python worker.
2. Jev called from the Next.js server.
3. Jev behind a dedicated model-provider service.
4. Jev plus a frontier LLM for explanations.
5. Jev plus deterministic template explanations only.

The recommended default is the smallest architecture that keeps Jev server-side, typed, auditable, replaceable, and easy to replay. Do not choose an architecture without checking the current Jev SDK/API documentation and the repository.

### Required fallback behavior

If Jev is unconfigured, unavailable, times out, rate-limited, or returns malformed output:

- preserve deterministic facts;
- show a transparent classification-pending or human-review-required state;
- use a deterministic template explanation if needed;
- never silently claim a successful Jev classification;
- never silently substitute another model unless explicitly configured and disclosed.

If an optional frontier LLM is enabled, it may only produce fact-grounded explanation, taxonomy mapping, or ambiguity flags. It cannot change arithmetic, Jev classification, confidence gates, policy results, or external actions.

### Data processing disclosure

Before external model processing, show the user that a minimized billing evidence packet may be processed by TypeSafe Jev and collect the configured consent basis. Document provider retention, deletion, region, and terms in the deployment notes.

## 9. Technical stack

### Web application

- Next.js with TypeScript;
- App Router;
- Tailwind CSS;
- shadcn/ui or a similarly small component set;
- server-side validation with Zod;
- simple responsive browser UI;
- no charting library unless a single lightweight chart materially improves comprehension.

### Database

- Managed Postgres: Neon or Supabase;
- Drizzle ORM or Prisma;
- UUID identifiers;
- tenant ID on every table;
- migrations committed to git;
- RLS or equivalent tenant isolation before real external uploads.

### Storage

- One private S3-compatible bucket;
- S3 is acceptable for AWS-aligned production;
- Cloudflare R2 is acceptable if minimizing egress matters;
- presigned upload/download URLs;
- no public objects;
- raw files deleted through an explicit workflow.

For local development, use filesystem storage or MinIO; do not require AWS credentials to run the test suite.

### Processing

- Python 3.12+;
- Polars;
- DuckDB;
- PyArrow;
- Pydantic;
- standard library CSV support;
- no Pandas requirement unless a specific dependency needs it;
- no OCR in MVP 0.

### Jobs

MVP 0:

- Postgres-backed jobs table;
- one worker process;
- retry count and idempotency key;
- no SQS required yet.

After upload volume justifies it:

- AWS SQS Standard;
- dead-letter queue;
- one job per source file or snapshot run.

### Authentication

MVP 0 options:

- magic-link email authentication via Clerk/Auth0/Supabase Auth;
- or a controlled passwordless pilot link if no sensitive data is retained.

Do not build organization-level roles beyond owner/admin/viewer in MVP 0.

### Email

- Resend, Postmark, or AWS SES;
- email only links and summary status;
- do not include raw billing rows in email.

### Billing

MVP 0:

- no billing required for the upload test;
- capture pilot interest and preferred price.

MVP 1:

- Stripe Checkout;
- Stripe webhook-entitlement flow;
- $499 paid 30-day pilot.

### Observability

- structured JSON logs;
- request ID and snapshot run ID;
- Sentry or equivalent error tracking;
- no billing rows, tags, or customer files in analytics events.

## 10. Minimal data model

```sql
create table tenant (
  id uuid primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table lead (
  id uuid primary key,
  tenant_id uuid references tenant(id),
  email text not null,
  first_name text,
  company_name text,
  company_domain text,
  role text,
  country text,
  provider text,
  spend_band text,
  biggest_problem text,
  pilot_interest text,
  consent_or_contact_basis text,
  created_at timestamptz not null default now()
);

create table source_file (
  id uuid primary key,
  lead_id uuid references lead(id),
  storage_key text not null,
  original_filename text not null,
  mime_type text not null,
  size_bytes bigint not null,
  sha256 text not null,
  status text not null,
  detected_period_start date,
  detected_period_end date,
  created_at timestamptz not null default now()
);

create table snapshot_run (
  id uuid primary key,
  source_file_id uuid references source_file(id),
  parser_version text not null,
  status text not null,
  rows_seen integer,
  rows_accepted integer,
  rows_rejected integer,
  total_cost numeric,
  currency text,
  data_readiness_score numeric,
  warnings jsonb not null default '[]',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table snapshot_finding (
  id uuid primary key,
  snapshot_run_id uuid references snapshot_run(id),
  category text not null,
  severity text not null,
  title text not null,
  explanation text not null,
  observed_value numeric,
  baseline_value numeric,
  delta_value numeric,
  estimated_monthly_impact_low numeric,
  estimated_monthly_impact_high numeric,
  owner text,
  evidence jsonb not null default '[]',
  missing_evidence jsonb not null default '[]',
  status text not null default 'preview',
  created_at timestamptz not null default now()
);

create table audit_event (
  id uuid primary key,
  tenant_id uuid references tenant(id),
  actor_type text not null,
  actor_id text,
  action text not null,
  object_type text not null,
  object_id text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
```

For MVP 0, `tenant_id` can represent a lead workspace. Before broad real-data use, implement proper authentication and RLS.

## 11. API surface

```text
POST /api/leads
POST /api/uploads/presign
POST /api/uploads/complete
POST /api/snapshots
GET  /api/snapshots/:id
GET  /api/snapshots/:id/findings
POST /api/pilot-requests
POST /api/admin/leads/:id/status
POST /api/admin/snapshots/:id/notes
DELETE /api/source-files/:id
```

### API rules

- Validate all request bodies with Zod/Pydantic.
- Never trust filename extension.
- Enforce maximum upload size server-side.
- Use idempotency keys for upload completion and snapshot creation.
- Return generic errors to users and detailed errors to logs.
- Do not expose storage keys to the browser.
- Do not accept arbitrary callback URLs.
- Do not allow uploaded content to become executable.

## 12. Repository structure

```text
cloud-cost-agent/
├── apps/
│   └── web/
│       ├── app/
│       │   ├── page.tsx
│       │   ├── snapshot/[id]/page.tsx
│       │   ├── upload/page.tsx
│       │   ├── admin/page.tsx
│       │   └── api/
│       ├── components/
│       ├── lib/
│       └── tests/
├── packages/
│   ├── domain/
│   ├── ui/
│   └── config/
├── worker/
│   ├── src/
│   │   ├── parsers/
│   │   ├── normalization/
│   │   ├── detectors/
│   │   ├── snapshots/
│   │   └── models/
│   └── tests/
├── db/
│   ├── migrations/
│   └── seed/
├── fixtures/
│   ├── valid_cost_explorer.csv
│   ├── valid_cur_sample.parquet
│   ├── malformed_missing_cost.csv
│   ├── duplicate_rows.csv
│   └── partial_period.csv
├── docs/
│   ├── product-spec.md
│   ├── security.md
│   └── local-development.md
├── .env.example
├── docker-compose.yml
├── package.json
├── pyproject.toml
└── README.md
```

## 13. Acceptance criteria

### Landing page

- A first-time visitor understands the product in under 30 seconds.
- Primary CTA opens the qualification form.
- Sample snapshot is visible without requiring signup.
- Page clearly says read-only, AWS-first, and no credentials required for the first review.
- No unsupported savings guarantee appears.
- Mobile layout works.
- Form records country, role, spend band, provider, and problem.

### Upload

- Accepts valid CSV files up to the configured size limit.
- Rejects unsupported types with a clear message.
- Does not trust file extensions.
- Shows upload progress and processing state.
- Produces a stable snapshot ID.
- Handles duplicate upload idempotently.

### Parser

- Detects required columns or returns actionable validation errors.
- Handles UTF-8 and common delimiter variation.
- Parses numeric costs without silently converting invalid values to zero.
- Preserves negative credits/refunds.
- Detects missing or partial periods.
- Produces rows-seen, rows-accepted, and rows-rejected counts.
- Re-running the same file produces the same normalized result.

### Findings

- Total cost reconciles to the accepted rows.
- Top services are sorted deterministically.
- Largest changes are reproducible.
- Unknown/missing dimensions are visible.
- Every finding includes source-file or row-level evidence where possible.
- The product abstains when data is insufficient.

### Security

- Uploaded files are private.
- Signed URLs expire.
- No file content appears in logs.
- No cloud credentials are collected.
- Delete flow removes the source file and derived snapshot data.
- Tenant access tests fail if one lead can access another lead’s snapshot.

### Admin

- Founder can see new leads and upload status.
- Founder can add a note and change lead status.
- Founder can resend or copy a result link.
- Admin routes are protected.

## 14. Week 1 execution sequence

### Day 1 — product shell

- Create repository.
- Create Next.js app.
- Add landing page copy.
- Add sample snapshot component.
- Add qualification form.
- Add local development instructions.

### Day 2 — upload and persistence

- Add Postgres schema/migrations.
- Add local storage adapter.
- Add upload endpoint.
- Add file metadata and SHA-256 hashing.
- Add upload validation.

### Day 3 — parser

- Implement Cost Explorer CSV parser.
- Add fixtures.
- Add period detection.
- Add numeric and currency validation.
- Add reconciliation tests.

### Day 4 — snapshot logic

- Implement top services.
- Implement period-over-period changes.
- Implement unknown dimensions.
- Implement data-readiness score.
- Implement deterministic finding cards.

### Day 5 — result and admin

- Build snapshot page.
- Build admin queue.
- Add status updates and founder notes.
- Add deletion flow.
- Add structured logs and error boundary.

### Day 6 — security and deployment

- Add authentication or protected pilot links.
- Add private object storage in staging.
- Add tenant-access tests.
- Add deployment configuration.
- Add Sentry or basic error reporting.

### Day 7 — test with real files

- Process at least three real or redacted exports.
- Record every parser failure.
- Fix only blocking failures.
- Send three snapshot links manually.
- Begin the 300-account outreach test.

## 15. MVP 0 metrics

Primary:

- qualified visitor → upload conversion;
- valid upload → completed snapshot conversion;
- completed snapshot → pilot request conversion;
- number of real exports uploaded;
- number of customers requesting a second cycle.

Secondary:

- data validation failure rate;
- time from upload to snapshot;
- percentage of findings with usable evidence;
- manual minutes per snapshot;
- percentage of prospects in target spend band;
- positive reply rate by country, persona, and message variant.

Do not optimize for:

- total page views;
- raw email collection;
- report opens without action;
- number of charts;
- model confidence alone;
- estimated savings without verification.

## 16. Known limitations to show users

- MVP 0 is AWS-first.
- Billing exports are not real-time.
- Billing data alone cannot prove safe rightsizing or deletion.
- The first snapshot is decision support, not an autonomous action.
- Estimated impact is an estimate, not guaranteed savings.
- Missing utilization, ownership, or environment data will cause escalation.
- Jev is not required for the deterministic MVP 0 result.

## 17. Transition to MVP 1

Do not begin MVP 1 until MVP 0 produces at least:

- 10 real qualified uploads;
- 5 completed snapshot reviews;
- 3 prospects requesting recurring monitoring;
- 2 paid pilot commitments or equivalent strong design-partner commitments;
- at least 1 accepted recommendation or decision;
- no unresolved cross-tenant data issue;
- a repeatable processing time below 30 minutes per snapshot after the initial manual work.

MVP 1 adds:

- AWS CUR 2.0 Parquet support;
- customer-specific materiality policies;
- Jev behind a feature flag;
- facts-only LLM explanations;
- human review state;
- AWS read-only connector;
- email digest;
- Stripe paid pilot;
- outcome verification.

## 18. Source notes

- AWS Cost and Usage Reports/Data Exports: https://docs.aws.amazon.com/cur/latest/userguide/what-is-cur.html and https://docs.aws.amazon.com/cur/latest/userguide/what-is-data-exports.html
- AWS Cost Explorer pricing and limits: https://aws.amazon.com/aws-cost-management/aws-cost-explorer/pricing
- FinOps Foundation State of FinOps: https://data.finops.org/ and https://data.finops.org/2025-report/
- FinOps engineering action challenge: https://www.finops.org/wg/encouraging-engineers-to-take-action/
- FinOps anomaly and ownership guidance: https://www.finops.org/wg/managing-cloud-cost-anomalies/
- Vantage capabilities: https://www.vantage.sh/
- Harness Cloud and AI Cost Management: https://www.harness.io/products/cloud-ai-cost-management
- TypeSafe Jev API: https://docs.typesafe.ai/api
- TypeSafe Jev model/pricing: https://docs.typesafe.ai/models
- TypeSafe commercial terms: https://typesafe.ai/legal/mca?render=full
