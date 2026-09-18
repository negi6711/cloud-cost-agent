"""The `snapshot.process` job: load the uploaded file for a run and analyze it.

Stages so far: load (integrity check) -> parse (normalize, data-quality issues). Analysis, the
evidence packet, Jev classification and the policy gate are added behind this entry point.

Parsed rows live only in memory for the duration of the job. What is persisted is aggregate:
counts, totals, the detected period, and issues whose messages are ours, never file contents.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

import structlog
from psycopg.types.json import Jsonb

from cca.db import Connection, tenant_transaction
from cca.jobs.errors import PermanentJobError, RetryableJobError
from cca.jobs.queue import Job
from cca.parsers import ParseError, ParseResult, parse_billing_export
from cca.storage import ObjectMissingError, ObjectStore, ObjectTooLargeError

log = structlog.get_logger("cca.snapshots")

_TERMINAL = ("completed", "insufficient_data", "failed")

LOAD_MESSAGES = {
    "file_too_large": "The file is larger than the 25 MB limit.",
    "integrity_mismatch": "The stored file does not match what was uploaded, so it was not analyzed. Please upload it again.",
}


class IntegrityError(PermanentJobError):
    """The stored object does not match the hash recorded at upload."""


Clock = Callable[[], date]


def utc_today() -> date:
    return datetime.now(UTC).date()


def make_handler(store: ObjectStore, max_bytes: int, today: Clock = utc_today) -> Callable[[Connection, Job], None]:
    def handle(conn: Connection, job: Job) -> None:
        process_snapshot(conn, job, store, max_bytes, today)

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


def _set_status(conn: Connection, run_id: UUID, status: str, warnings: list[dict[str, Any]] | None = None) -> None:
    conn.execute(
        "UPDATE snapshot_run SET status = %s, warnings = warnings || %s, "
        "completed_at = CASE WHEN %s = ANY(%s) THEN now() ELSE completed_at END "
        "WHERE id = %s",
        (status, Jsonb(warnings or []), status, list(_TERMINAL), run_id),
    )


def _fail(conn: Connection, job: Job, run: dict[str, Any], issue: dict[str, Any]) -> None:
    with tenant_transaction(conn, job.tenant_id):
        _set_status(conn, run["id"], "failed", [issue])
        conn.execute("UPDATE source_file SET status = 'failed' WHERE id = %s", (run["source_file_id"],))


def _load_issue(code: str) -> dict[str, Any]:
    return {"code": code, "severity": "error", "stage": "load", "message": LOAD_MESSAGES[code]}


def process_snapshot(
    conn: Connection, job: Job, store: ObjectStore, max_bytes: int, today: Clock = utc_today
) -> None:
    run_id = UUID(str(job.payload["snapshotRunId"]))
    with tenant_transaction(conn, job.tenant_id):
        run = _load_run(conn, run_id)
        if run["status"] in _TERMINAL:
            log.info("snapshot.already_finished", run_id=str(run_id), status=run["status"])
            return

    # ---- load
    try:
        data = store.read(run["storage_key"], max_bytes)
    except ObjectMissingError as exc:
        raise RetryableJobError("uploaded object not readable yet") from exc
    except ObjectTooLargeError as exc:
        _fail(conn, job, run, _load_issue("file_too_large"))
        raise PermanentJobError("uploaded object exceeds the size limit") from exc
    if hashlib.sha256(data).hexdigest() != run["sha256"]:
        _fail(conn, job, run, _load_issue("integrity_mismatch"))
        raise IntegrityError("stored object hash differs from upload hash")

    with tenant_transaction(conn, job.tenant_id):
        _set_status(conn, run_id, "parsing")

    # ---- parse
    try:
        result = parse_billing_export(data, today=today())
    except ParseError as exc:
        # A data problem, not a job failure: record why and finish. Retrying the same bytes cannot help.
        _fail(conn, job, run, exc.to_issue().to_json(stage="parse"))
        log.info("snapshot.parse_failed", run_id=str(run_id), code=exc.code)
        return
    finally:
        del data

    _record_parse(conn, job, run, result)
    log.info(
        "snapshot.parsed",
        run_id=str(run_id),
        layout=str(result.layout),
        lines_seen=result.stats.lines_seen,
        lines_rejected=result.stats.lines_rejected,
        issues=len(result.issues),
    )


def _record_parse(conn: Connection, job: Job, run: dict[str, Any], result: ParseResult) -> None:
    s = result.stats
    with tenant_transaction(conn, job.tenant_id):
        conn.execute(
            "UPDATE snapshot_run SET rows_seen = %s, rows_accepted = %s, rows_rejected = %s, "
            "total_cost = %s, currency = %s WHERE id = %s",
            (s.lines_seen, s.lines_accepted, s.lines_rejected, result.total_cost, result.currency, run["id"]),
        )
        _set_status(conn, run["id"], "analyzing", [i.to_json() for i in result.issues])
        conn.execute(
            "UPDATE source_file SET status = 'processed', dimension = %s, "
            "detected_period_start = %s, detected_period_end = %s WHERE id = %s",
            (result.primary_dimension, result.period_start, result.period_end, run["source_file_id"]),
        )
