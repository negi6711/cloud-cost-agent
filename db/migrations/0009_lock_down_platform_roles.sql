-- Defense in depth for hosted Postgres (Supabase).
--
-- 1. Supabase exposes the `public` schema through its Data API (PostgREST/GraphQL) using the roles
--    `anon` and `authenticated`, and by default grants them privileges on every table. We never use
--    that API. Revoke those privileges now and for future tables. (No-op on plain Postgres.)
-- 2. The identity tables (Better Auth: user, session, account, verification) hold no tenant data and
--    so had no RLS. Enable RLS with a policy for the application role only, so no other role can
--    read them even if it is granted privileges later.

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user', 'session', 'account', 'verification'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_only ON %I FOR ALL TO cca_app USING (true) WITH CHECK (true)', t);
  END LOOP;
END
$$;
