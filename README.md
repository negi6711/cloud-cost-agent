# Cloud Cost Decision Snapshot

Upload an AWS billing export and get back a ranked report of what changed, why it changed, who
probably owns it, and what evidence is missing before anyone should act on it.

**Status: finished experiment.** Built in September 2026 as a solo MVP to test whether engineering
teams would upload real AWS bills. It works end to end and has a live staging deployment, but I have
moved on to another product. The code, the tests and the decision records are kept here as they were.

Live demo: https://cca-web-0l1q.onrender.com — free hosting, so the first load after a quiet spell
takes about 45 seconds while it wakes. Upload one of the files in [`fixtures/icp/`](fixtures/icp) to
see the teaser; the full report sits behind an email sign-in that only delivers to the owner on this
deployment.

## What it does

1. A visitor uploads an AWS **Cost Explorer** CSV or a **Cost and Usage Report** export (no AWS
   credentials, no API access, read-only by construction).
2. A Python worker parses and validates it, normalises it to monthly totals, and finds material
   month-over-month movements by service, account, region, tag and usage type.
3. Each movement becomes a finding with its source cells (`L5, L6, L8…`), a volume-versus-rate split
   ("usage tripled at a flat price"), named evidence gaps, and a next step.
4. With the visitor's per-upload consent, a minimised evidence packet is sent to a typed
   classification model (TypeSafe Jev) as a second opinion. A deterministic policy gate decides what
   is published.
5. The visitor sees a teaser immediately; the full report unlocks via an email magic link. A later
   upload reports what became of last month's findings.

## Design rules the code enforces

- **Deterministic code owns every number.** Model output is an untrusted suggestion that must pass
  schema validation and the policy gate.
- **Billing data never yields RESIZE, DELETE, STOP or BUY COMMITMENT.** The only categories are
  INVESTIGATE, REQUEST EVIDENCE, MONITOR and ESCALATE.
- **Invalid numbers are rejected, never converted to zero.**
- **Model keys live only in the worker**; the web app never sees them.
- **Tenant isolation** through one scoping chokepoint plus Postgres row-level security, tested as the
  application role.

## What I learned

The most useful output of this project is the measurement in the decision records:

- **The model changed 74% of decisions but used only two of four categories.** Across 58 findings it
  answered only INVESTIGATE or REQUEST EVIDENCE, never MONITOR or ESCALATE, with median confidence
  0.43. ([ADR 0003](docs/adr/0003-what-the-model-is-actually-for.md))
- **A richer evidence packet did not fix it.** An A/B run with pre-registered pass bars cleared 2 of 5.
  Confidence rose only where the added evidence settled the question (GPU hours 0.27 → 0.68), and
  elsewhere the model hedged harder. So the rules publish every category and production stays on
  the smaller packet, which also sends less customer data.
  ([ADR 0004](docs/adr/0004-can-the-classifier-be-made-sound.md))
- **The arithmetic is not the product.** Totals and deltas are reproducible in a spreadsheet; what is
  not is provenance for every number, refusing to compare a partial month, and remembering last
  month's findings. ([positioning](docs/positioning.md), [ADR 0005](docs/adr/0005-the-verification-loop.md))

## Stack

| Part | Tech |
|---|---|
| Web app | Next.js (App Router), TypeScript, Tailwind, Better Auth (magic links), Zod |
| Worker | Python 3.12, Polars, Pydantic, FastAPI, psycopg |
| Data | PostgreSQL with RLS, migrations via Drizzle Kit |
| Storage | Cloudflare R2 via presigned uploads (local disk in development) |
| Hosting | Render (web + worker), Supabase Postgres |
| Tests | pytest, Vitest, Playwright; CI on GitHub Actions against a real Postgres |

```
apps/web/         Next.js app: landing, upload + teaser, email gate, report, admin
packages/domain   Zod schemas shared by the web app
packages/config   Shared constants
worker/           Python worker: parsing, analysis, evidence packets, classifier, policy gate
db/migrations     SQL migrations
fixtures/         Synthetic billing exports, including a 17-scenario test corpus
docs/             Product spec, ADRs, security, local development, deployment
```

## Running it locally

Everything runs on one machine with **no cloud accounts and no API keys**: local file storage, a
mock classifier and a dev inbox for sign-in links. You need Node 20+, [uv](https://docs.astral.sh/uv/)
and PostgreSQL 17.

```bash
npm install && uv sync
npm run env:init && npm run db:setup-local && npm run db:migrate
npm run dev                  # http://localhost:3000
uv run python -m cca         # worker on :8001
```

Full instructions, including tests: [`docs/local-development.md`](docs/local-development.md).
The real classifier needs a TypeSafe API key (`JEV_ENABLED=true`, `TYPESAFE_API_KEY`); without one the
report shows the deterministic findings marked for human review.

## Documents

- [`docs/product-spec.md`](docs/product-spec.md): scope and resolved conflicts
- [`docs/adr/`](docs/adr): architecture and measurement decisions
- [`docs/security.md`](docs/security.md): data handling, provider terms, retention
- [`docs/parser.md`](docs/parser.md): supported export layouts

## License

[MIT](LICENSE)
