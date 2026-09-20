# Deployment (staging on Render + Cloudflare R2 + Supabase, US East)

We do this together, one step at a time; each step ends with a check. Secrets go into dashboards
or your local `.env`, never into chat or git.

## 0. Before you start

- Accounts: Supabase, Cloudflare (R2), Render, Resend. TypeSafe can come later.
- Locally, `main` checks pass: `uv run pytest`, `npm test`, `npm run build`.

## 1. Supabase (database only)

1. New project, region **US East (N. Virginia)**. Save the database password in your password manager.
2. Run migrations from your laptop against the **direct** connection string (owner role `postgres`):
   `DATABASE_MIGRATION_URL=<direct URL> npm run migrate -w @cca/db`.
   Check: tables `lead`, `source_file`, `snapshot_run` exist in the Table editor.
3. Give the application role a login (SQL editor), with a long random password:
   `ALTER ROLE cca_app LOGIN PASSWORD '<random 32+ chars>';`
   Check: RLS shows **enabled** on every table except the auth tables (`user`, `session`, `account`,
   `verification`).
4. The runtime `DATABASE_URL` uses the **pooler** (transaction mode, port 6543) with user
   `cca_app.<project-ref>`. The worker disables prepared statements for this pooler.

## 2. Cloudflare R2 (private file storage)

1. Create bucket `cca-staging-uploads`. Public access: **off**.
2. CORS policy on the bucket (browser uploads go straight to R2):
   ```json
   [{ "AllowedOrigins": ["https://cca-web.onrender.com"], "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 600 }]
   ```
3. API token: **Object Read & Write**, scoped to this bucket only. Note the account ID, access key ID
   and secret.

## 3. Resend (email, until a domain exists)

1. Create an API key. Without a verified domain, `EMAIL_FROM=onboarding@resend.dev` delivers **only to
   your own Resend account email**, which is enough for staging. Real prospects need a domain.

## 4. Render

1. New **Blueprint** from this repository (`render.yaml`). Render creates `cca-web`, `cca-worker` and
   the `cca-shared` env group, and generates the shared secrets.
2. Fill the `sync: false` values:
   - `cca-shared`: `DATABASE_URL` (step 1.4), `R2_*` (step 2).
   - `cca-web`: `APP_BASE_URL` (its own https URL), `WORKER_URL` (the worker's https URL),
     `ADMIN_EMAILS` (your email), `RESEND_API_KEY`, `EMAIL_FROM`.
   - `cca-worker`: `JEV_ENABLED` (set `false` until the TypeSafe key is verified), `TYPESAFE_API_KEY`.
3. Deploy. Checks: `https://cca-worker…/healthz` returns `{"status":"ok"}`; the landing page loads.

## 5. Smoke test on staging

1. Fill the form with your own email, upload `fixtures/valid_cost_explorer.csv`.
2. The sign-in email arrives (Resend); the snapshot shows 2 findings, "rule-based" classification.
3. Sign in at `/admin` with the `ADMIN_EMAILS` address; the lead is in the queue.
4. Delete the file from the snapshot page; the object disappears from the R2 bucket.

## 6. Later

- **TypeSafe key:** set `TYPESAFE_API_KEY` on `cca-worker`, run `uv run python -m cca.jev_smoke` locally
  with the same key first, then set `JEV_ENABLED=true` in the dashboard.

  Both are declared `sync: false` in `render.yaml` on purpose: a blueprint sync re-applies every
  value the blueprint declares, so a literal `JEV_ENABLED: "false"` there would switch
  classification back off on the next unrelated deploy — silently, because a rule-based report
  looks complete. `worker/tests/test_deploy_config.py` fails if either one is given a value again,
  and the worker logs `worker.classification` at startup so the state is visible in the Render log.
- **Launch:** move both services to a paid instance type; verify a sending domain in Resend and set
  `EMAIL_FROM`; update the R2 CORS origin and `APP_BASE_URL` if the domain changes.

## Environment rules enforced at startup

- `APP_ENV=staging|production` refuses local file storage, the dev inbox, the mock classifier and
  unpinned Jev models (`jev-latest`).
- The TypeSafe key exists only on the worker. The web app never reads it.
