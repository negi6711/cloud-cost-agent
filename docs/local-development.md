# Local development

Everything runs on one machine with no cloud accounts and no API keys.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 (tested on 22) | npm workspaces; pnpm is not required |
| uv | ≥ 0.12 | installs and manages Python 3.12 |
| PostgreSQL | 17 | a native install on port 5432, or `docker compose up postgres` |

## First-time setup

```bash
npm install                   # web app + shared packages
uv sync                       # Python worker (creates .venv with Python 3.12)
npm run env:init              # .env from .env.example with fresh random local secrets
npm run db:setup-local        # creates role cca_app and databases cca_dev + cca_test (localhost only)
npm run db:migrate            # applies db/migrations to cca_dev
npm run db:migrate:test       # applies db/migrations to cca_test
```

`.env` assumes the local Postgres superuser is `postgres` / `postgres`. If yours differs, edit
`DATABASE_MIGRATION_URL` and `TEST_DATABASE_MIGRATION_URL` in `.env` (never commit it).

## Run

```bash
npm run dev                   # web app on http://localhost:3000
uv run python -m cca          # worker on http://localhost:8001 (WORKER_URL in .env points here)
```

Sign-in emails go to the dev inbox: open http://localhost:3000/dev/inbox and click the link.
To use the admin view, put your own email in `ADMIN_EMAILS` in `.env` (comma-separated).

The web app enqueues a job row and "kicks" the worker over HTTP (HMAC-signed). The worker also polls,
so it catches up if a kick is missed. Uploaded files land in `LOCAL_STORAGE_DIR` (`.local-storage/`).

The npm scripts load the repo-root `.env` (`apps/web/scripts/next.mjs`); there is no
`apps/web/.env.local`.

## Checks

```bash
# worker
uv run pytest
uv run ruff check
uv run mypy

# web
npm run lint
npm run typecheck
npm test                      # Vitest; integration tests use cca_test
npm run build
npm run build                 # e2e runs against the production build
npm run test:e2e -w @cca/web  # Playwright, desktop + mobile; starts web + worker on cca_test
```

One-time for e2e: `npx playwright install chromium` in `apps/web`.

## Database model

- Runtime connections use `cca_app`, which is **not** the schema owner and is subject to row-level
  security. Every transaction declares its tenant through `withTenant()` (`apps/web/lib/db.ts`).
- Migrations run as the owner (`DATABASE_MIGRATION_URL`). Schema changes go in `db/src/schema.ts`,
  then `npm run db:generate` writes a new SQL migration to commit.
- Every table has `tenant_id`; `apps/web/tests/tenant-isolation.test.ts` fails if a table with
  `tenant_id` lacks RLS or its policy.

## Local modes

| Concern | Local default | Hosted |
|---|---|---|
| Database | native Postgres `cca_dev` | Supabase Postgres (US East) |
| File storage | `STORAGE_DRIVER=local` — files in `.local-storage/`, HMAC-signed expiring URLs | Cloudflare R2 private bucket |
| Jev | `JEV_ENABLED=false` (rule-based). Set `JEV_ENABLED=true` + `JEV_PROVIDER=mock` for the labelled test classifier | `JEV_PROVIDER=typesafe`, pinned `JEV_MODEL`, server-side key |
| Login emails | `EMAIL_DRIVER=dev-inbox` — links appear at `/dev/inbox` and in the console | Resend (needs a verified domain) |


## Jev tools

```bash
uv run python -m cca.jev_smoke                                  # one real call on SYNTHETIC fixture data
uv run python -m cca.replay --tenant <uuid> --run <uuid>        # re-validate a run's stored answers
uv run python -m cca.replay --tenant <uuid> --run <uuid> --live # ask the provider again (consented runs only)
```

The question set lives in `worker/src/cca/providers/jev_questions_v1.py` (review before changing;
bump `QUESTION_SET_VERSION` in both `worker/src/cca/versions.py` and `packages/config/src/index.ts`).
