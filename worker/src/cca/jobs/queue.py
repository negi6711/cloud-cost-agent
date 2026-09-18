"""Postgres-backed job queue (the `job` table). One job per snapshot run; see migration 0001."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from uuid import UUID

from cca.db import Connection, tenant_transaction

RETRY_BASE_SECONDS = 30
RETRY_MAX_SECONDS = 15 * 60


@dataclass(frozen=True)
class Job:
    id: UUID
    tenant_id: UUID
    kind: str
    payload: dict[str, Any]
    attempts: int
    max_attempts: int

    @property
    def is_last_attempt(self) -> bool:
        return self.attempts >= self.max_attempts


def claim(conn: Connection, worker_id: str, lease_seconds: int) -> Job | None:
    """Lease the next runnable job (queued, or running with an expired lease) across tenants."""
    row = conn.execute("SELECT * FROM claim_next_job(%s, %s)", (worker_id, lease_seconds)).fetchone()
    if row is None:
        return None
    return Job(
        id=row["id"],
        tenant_id=row["tenant_id"],
        kind=row["kind"],
        payload=dict(row["payload"] or {}),
        attempts=row["attempts"],
        max_attempts=row["max_attempts"],
    )


def reap_exhausted(conn: Connection) -> int:
    """Mark jobs dead whose lease expired on their final attempt."""
    row = conn.execute("SELECT reap_exhausted_jobs() AS n").fetchone()
    return int(row["n"]) if row else 0


def mark_succeeded(conn: Connection, job: Job) -> None:
    with tenant_transaction(conn, job.tenant_id):
        conn.execute(
            "UPDATE job SET status = 'succeeded', locked_by = NULL, locked_until = NULL, "
            "last_error_class = NULL, updated_at = now() WHERE id = %s",
            (job.id,),
        )


def retry_delay(attempts: int) -> timedelta:
    return timedelta(seconds=min(RETRY_BASE_SECONDS * 2 ** max(attempts - 1, 0), RETRY_MAX_SECONDS))


def mark_failed(conn: Connection, job: Job, error_class: str, *, retryable: bool) -> str:
    """Requeue with backoff if retryable and attempts remain; otherwise mark dead. Returns new status."""
    status = "queued" if retryable and not job.is_last_attempt else "dead"
    with tenant_transaction(conn, job.tenant_id):
        conn.execute(
            "UPDATE job SET status = %s, run_after = now() + %s, locked_by = NULL, locked_until = NULL, "
            "last_error_class = %s, updated_at = now() WHERE id = %s",
            (status, retry_delay(job.attempts), error_class, job.id),
        )
    return status
