-- Retention now has two windows, because uploads happen before the email gate:
--   * a file nobody claimed (no lead attached) is deleted sooner — we cannot contact that person,
--     so holding their billing data longer has no purpose;
--   * an unlocked file keeps the standard window.
-- Replaces the single-window function from migration 0008.

DROP FUNCTION IF EXISTS raw_files_due_for_deletion(integer, integer);
--> statement-breakpoint

CREATE FUNCTION raw_files_due_for_deletion(p_days integer, p_anonymous_days integer, p_limit integer)
  RETURNS TABLE (tenant_id uuid, id uuid, storage_key text, claimed boolean)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT tenant_id, id, storage_key, lead_id IS NOT NULL AS claimed
    FROM source_file
    WHERE raw_deleted_at IS NULL
      AND created_at < now() - make_interval(days => CASE WHEN lead_id IS NULL THEN p_anonymous_days ELSE p_days END)
    ORDER BY created_at
    LIMIT p_limit
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION raw_files_due_for_deletion(integer, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION raw_files_due_for_deletion(integer, integer, integer) TO cca_app;
