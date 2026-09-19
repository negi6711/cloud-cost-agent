-- Raw-file retention: the worker's sweeper lists files whose raw object is past the retention window,
-- across tenants. Returns only ids and storage keys (no contents); each deletion is then performed
-- under that file's own tenant context.

CREATE FUNCTION raw_files_due_for_deletion(p_days integer, p_limit integer)
  RETURNS TABLE (tenant_id uuid, id uuid, storage_key text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT tenant_id, id, storage_key
    FROM source_file
    WHERE raw_deleted_at IS NULL
      AND created_at < now() - make_interval(days => p_days)
    ORDER BY created_at
    LIMIT p_limit
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION raw_files_due_for_deletion(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION raw_files_due_for_deletion(integer, integer) TO cca_app;
