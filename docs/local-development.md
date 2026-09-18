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
```

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
npm run test:e2e -w @cca/web  # Playwright, desktop + mobile, against a production build on cca_test
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
| Jev | `JEV_PROVIDER=mock`, `JEV_ENABLED=false` | `JEV_PROVIDER=typesafe` with a server-side key |
| Login emails | `EMAIL_DRIVER=dev-inbox` — links appear at `/dev/inbox` and in the console | Resend (needs a verified domain) |

The worker run command is added here when the worker service lands (Day 2).
