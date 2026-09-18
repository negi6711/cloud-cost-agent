"""The `snapshot.process` job: load the uploaded file for a run and analyze it.

Day 2 scope: verify the file's integrity and move the run to `parsing`. Parsing, analysis, the
evidence packet, Jev classification and the policy gate are added behind this entry point.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from typing import Any
from uuid import UUID

import structlog
from psycopg.types.json import Jsonb

from cca.db import Connection, tenant_transaction
from cca.jobs.errors import PermanentJobError, RetryableJobError
from cca.jobs.queue import Job
from cca.storage import ObjectMissingError, ObjectStore, ObjectTooLargeError

log = structlog.get_logger("cca.snapshots")


class IntegrityError(PermanentJobError):
    """The stored object does not match the hash recorded at upload."""


def make_handler(store: ObjectStore, max_bytes: int) -> Callable[[Connection, Job], None]:
    def handle(conn: Connection, job: Job) -> None:
        process_snapshot(conn, job, store, max_bytes)

    return handle


def _load_run(conn: Connection, run_id: UUID) -> dict[str, Any]:
    row = conn.execute(
        "SELECT r.id, r.status, r.source_file_id, f.storage_key, f.sha256, f.size_bytes "
        "FROM snapshot_run r JOIN source_file f "
        "  ON f.tenant_id = r.tenant_id AND f.id = r.source_file_id "
        "WHERE r.id = %s",
        (run_id,),
    ).fetchone()
    if row is None:
        raise PermanentJobError("snapshot run not found for this tenant")
    return dict(row)


_TERMINAL = ("completed", "insufficient_data", "failed")


def _set_status(conn: Connection, run_id: UUID, status: str, warning: dict[str, str] | None = None) -> None:
    conn.execute(
        "UPDATE snapshot_run SET status = %s, warnings = warnings || %s, "
        "completed_at = CASE WHEN %s = ANY(%s) THEN now() ELSE completed_at END "
        "WHERE id = %s",
        (status, Jsonb([warning] if warning else []), status, list(_TERMINAL), run_id),
    )


def process_snapshot(conn: Connection, job: Job, store: ObjectStore, max_bytes: int) -> None:
    run_id = UUID(str(job.payload["snapshotRunId"]))
    with tenant_transaction(conn, job.tenant_id):
        run = _load_run(conn, run_id)
        if run["status"] in _TERMINAL:
            log.info("snapshot.already_finished", run_id=str(run_id), status=run["status"])
            return

    try:
        data = store.read(run["storage_key"], max_bytes)
    except ObjectMissingError as exc:
        raise RetryableJobError("uploaded object not readable yet") from exc
    except ObjectTooLargeError as exc:
        _fail(conn, job, run_id, "file_too_large")
        raise PermanentJobError("uploaded object exceeds the size limit") from exc

    if hashlib.sha256(data).hexdigest() != run["sha256"]:
        _fail(conn, job, run_id, "integrity_mismatch")
        raise IntegrityError("stored object hash differs from upload hash")

    with tenant_transaction(conn, job.tenant_id):
        _set_status(conn, run_id, "parsing")
    log.info("snapshot.integrity_verified", run_id=str(run_id), size_bytes=len(data))


def _fail(conn: Connection, job: Job, run_id: UUID, code: str) -> None:
    with tenant_transaction(conn, job.tenant_id):
        _set_status(conn, run_id, "failed", {"code": code, "stage": "load"})
