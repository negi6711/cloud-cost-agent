-- Narrow cross-tenant lookups keyed by email, for the login flow only.
--
--   lead_email_exists(email)     -> whether a login link may be sent to this address at all
--                                   (checked silently; the response never reveals the answer).
--   tenant_ids_for_email(email)  -> the workspaces a *verified* email may view. Called only with the
--                                   email of an authenticated Better Auth session.
--
-- Both run as the owner (SECURITY DEFINER) so they can read `lead` without a tenant context, and
-- both return only ids/booleans, never lead rows.

CREATE FUNCTION lead_email_exists(p_email text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM lead WHERE lower(email) = lower(p_email)) $$;
--> statement-breakpoint

CREATE FUNCTION tenant_ids_for_email(p_email text)
  RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ SELECT DISTINCT tenant_id FROM lead WHERE lower(email) = lower(p_email) $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION lead_email_exists(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tenant_ids_for_email(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION lead_email_exists(text) TO cca_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tenant_ids_for_email(text) TO cca_app;
