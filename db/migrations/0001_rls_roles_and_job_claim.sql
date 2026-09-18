-- Tenant isolation, application role, and the narrow job-claim functions.
--
-- Model:
--   * Migrations run as the schema owner. The owner is not subject to RLS (no FORCE), which is what
--     lets the SECURITY DEFINER functions below claim jobs across tenants.
--   * The web app and the worker connect as `cca_app`: not the owner, no BYPASSRLS, so every query
--     is filtered by the policies below.
--   * Each transaction declares its tenant with set_config('app.tenant_id', <uuid>, true).
--     Admin routes additionally set app.is_admin = 'on' after the admin session check.
--   * Login and password for cca_app are set outside migrations (db/scripts/setup-local.mjs locally,
--     a manual step on Supabase); no secret ever lives in a migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cca_app') THEN
    CREATE ROLE cca_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO cca_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cca_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cca_app;
--> statement-breakpoint
-- The audit trail is append-only for the application.
REVOKE UPDATE, DELETE ON audit_event FROM cca_app;
--> statement-breakpoint

CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint

CREATE FUNCTION app_is_admin() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.is_admin', true), '') = 'on' $$;
--> statement-breakpoint

-- One policy per tenant-scoped table. A test asserts that every table with a tenant_id column has
-- RLS enabled and this policy, so a future table cannot silently skip isolation.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenant_id'
      AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO cca_app '
      'USING (tenant_id = app_current_tenant() OR app_is_admin()) '
      'WITH CHECK (tenant_id = app_current_tenant() OR app_is_admin())',
      t
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- Claim the next runnable job for a worker, across tenants. SKIP LOCKED lets several workers run
-- safely; an expired lease makes a crashed worker's job claimable again.
CREATE FUNCTION claim_next_job(p_worker text, p_lease_seconds integer)
  RETURNS SETOF job
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE job
    SET status = 'running',
        attempts = attempts + 1,
        locked_by = p_worker,
        locked_until = now() + make_interval(secs => p_lease_seconds),
        updated_at = now()
    WHERE id = (
      SELECT id
      FROM job
      WHERE attempts < max_attempts
        AND (
          (status = 'queued' AND run_after <= now())
          OR (status = 'running' AND locked_until < now())
        )
      ORDER BY run_after, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *;
  $$;
--> statement-breakpoint

-- Jobs whose lease expired after their final attempt can never be claimed again: mark them dead so
-- they surface in the admin queue instead of hanging in "running".
CREATE FUNCTION reap_exhausted_jobs()
  RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH reaped AS (
      UPDATE job
      SET status = 'dead', last_error_class = coalesce(last_error_class, 'LeaseExpired'),
          locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE status = 'running' AND locked_until < now() AND attempts >= max_attempts
      RETURNING 1
    )
    SELECT count(*)::integer FROM reaped;
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION claim_next_job(text, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reap_exhausted_jobs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_next_job(text, integer) TO cca_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reap_exhausted_jobs() TO cca_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_tenant() TO cca_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_is_admin() TO cca_app;
