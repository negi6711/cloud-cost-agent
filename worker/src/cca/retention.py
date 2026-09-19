"""Raw-file retention: delete uploaded objects older than RAW_FILE_RETENTION_DAYS.

Derived data (facts, findings, packets, model-call records) is kept until the prospect or the
founder deletes the file (docs/security.md). Each deletion runs under the file's own tenant
context and leaves a content-free audit event.
"""

from __future__ import annotations

from dataclasses import dataclass

import structlog
from psycopg.types.json import Jsonb

from cca.db import Connection, tenant_transaction
from cca.storage import ObjectStore, key_belongs_to_tenant

log = structlog.get_logger("cca.retention")

BATCH = 100


@dataclass(frozen=True)
class SweepResult:
    deleted: int
    failed: int


def sweep(conn: Connection, store: ObjectStore, retention_days: int, limit: int = BATCH) -> SweepResult:
    due = conn.execute("SELECT * FROM raw_files_due_for_deletion(%s, %s)", (retention_days, limit)).fetchall()
    deleted = failed = 0
    for row in due:
        tenant_id, file_id, key = str(row["tenant_id"]), row["id"], row["storage_key"]
        if not key_belongs_to_tenant(key, tenant_id):
            log.error("retention.key_tenant_mismatch", source_file_id=str(file_id))
            failed += 1
            continue
        try:
            store.delete(key)
        except Exception as exc:  # noqa: BLE001 - keep sweeping; this file is retried on the next sweep
            log.warning("retention.delete_failed", source_file_id=str(file_id), error_class=type(exc).__name__)
            failed += 1
            continue
        with tenant_transaction(conn, tenant_id):
            conn.execute("UPDATE source_file SET raw_deleted_at = now() WHERE id = %s", (file_id,))
            conn.execute(
                "INSERT INTO audit_event (tenant_id, actor_type, action, object_type, object_id, metadata) "
                "VALUES (%s, 'system', 'raw_file.deleted_by_retention', 'source_file', %s, %s)",
                (tenant_id, str(file_id), Jsonb({"retention_days": retention_days})),
            )
        deleted += 1
    if deleted or failed:
        log.info("retention.swept", deleted=deleted, failed=failed)
    return SweepResult(deleted, failed)
