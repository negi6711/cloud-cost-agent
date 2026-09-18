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
cp .env.example .env          # placeholders work as-is for local mode
npm install                   # web app + shared packages
uv sync                       # Python worker (creates .venv with Python 3.12)
```

## Checks

```bash
# worker
uv run pytest
uv run ruff check
uv run mypy

# web
npm run lint
npm run typecheck
npm run build
```

## Local modes

| Concern | Local default | Hosted |
|---|---|---|
| Database | native Postgres `cca_dev` | Supabase Postgres (US East) |
| File storage | `STORAGE_DRIVER=local` — files in `.local-storage/`, HMAC-signed expiring URLs | Cloudflare R2 private bucket |
| Jev | `JEV_PROVIDER=mock`, `JEV_ENABLED=false` | `JEV_PROVIDER=typesafe` with a server-side key |
| Login emails | `EMAIL_DRIVER=dev-inbox` — links appear at `/dev/inbox` and in the console | Resend (needs a verified domain) |

Database creation, migrations and the worker/web run commands are added to this page as each is built.
