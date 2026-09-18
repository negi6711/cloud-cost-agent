from __future__ import annotations

import psycopg
from psycopg.rows import DictRow

from cca.db import Connection, connect, tenant_transaction
from cca.jobs import queue
from cca.settings import Settings


def job_row(owner: psycopg.Connection[DictRow], job_id: object) -> DictRow:
    row = owner.execute("SELECT * FROM job WHERE id = %s", (job_id,)).fetchone()
    assert row is not None
    return row


def test_app_role_sees_no_jobs_without_a_tenant(seed, app_conn: Connection) -> None:  # type: ignore[no-untyped-def]
    seed()
    assert app_conn.execute("SELECT count(*) AS n FROM job").fetchone() == {"n": 0}


def test_app_role_sees_only_its_tenants_jobs(seed, app_conn: Connection) -> None:  # type: ignore[no-untyped-def]
    a, _b = seed(), seed()
    with tenant_transaction(app_conn, a.tenant_id):
        rows = app_conn.execute("SELECT id FROM job").fetchall()
    assert [r["id"] for r in rows] == [a.job_id]


def test_claim_leases_one_job_and_increments_attempts(seed, owner, app_conn: Connection) -> None:  # type: ignore[no-untyped-def]
    s = seed()
    job = queue.claim(app_conn, "w1", 60)
    assert job is not None and job.id == s.job_id and job.attempts == 1
    assert job.payload["snapshotRunId"] == str(s.run_id)
    assert queue.claim(app_conn, "w2", 60) is None  # leased, not claimable again
    row = job_row(owner, s.job_id)
    assert row["status"] == "running" and row["locked_by"] == "w1"


def test_concurrent_claims_never_share_a_job(seed, settings: Settings) -> None:  # type: ignore[no-untyped-def]
    seed()
    seed()
    with connect(settings.database_url) as c1, connect(settings.database_url) as c2:
        c1_tx = c1.transaction()
        c1_tx.__enter__()  # hold c1's row lock open while c2 claims
        first = queue.claim(c1, "w1", 60)
        second = queue.claim(c2, "w2", 60)
        c1_tx.__exit__(None, None, None)
    assert first is not None and second is not None
    assert first.id != second.id


def test_expired_lease_is_reclaimed_then_reaped_when_exhausted(seed, owner, app_conn: Connection) -> None:  # type: ignore[no-untyped-def]
    s = seed(max_attempts=2)
    for attempt in (1, 2):
        job = queue.claim(app_conn, "w", 60)
        assert job is not None and job.attempts == attempt
        owner.execute("UPDATE job SET locked_until = now() - interval '1 second' WHERE id = %s", (s.job_id,))
    assert queue.claim(app_conn, "w", 60) is None  # attempts exhausted
    assert queue.reap_exhausted(app_conn) == 1
    row = job_row(owner, s.job_id)
    assert row["status"] == "dead" and row["last_error_class"] == "LeaseExpired"


def test_retryable_failure_requeues_with_backoff_and_last_attempt_goes_dead(seed, owner, app_conn: Connection) -> None:  # type: ignore[no-untyped-def]
    s = seed(max_attempts=2)
    job = queue.claim(app_conn, "w", 60)
    assert job is not None
    assert queue.mark_failed(app_conn, job, "Boom", retryable=True) == "queued"
    row = job_row(owner, s.job_id)
    assert row["run_after"] > row["updated_at"]  # scheduled in the future
    assert queue.claim(app_conn, "w", 60) is None  # not before run_after

    owner.execute("UPDATE job SET run_after = now() WHERE id = %s", (s.job_id,))
    job = queue.claim(app_conn, "w", 60)
    assert job is not None and job.is_last_attempt
    assert queue.mark_failed(app_conn, job, "Boom", retryable=True) == "dead"


def test_permanent_failure_is_dead_immediately(seed, owner, app_conn: Connection) -> None:  # type: ignore[no-untyped-def]
    s = seed()
    job = queue.claim(app_conn, "w", 60)
    assert job is not None
    assert queue.mark_failed(app_conn, job, "Bad", retryable=False) == "dead"
    assert job_row(owner, s.job_id)["status"] == "dead"


def test_retry_delay_is_bounded() -> None:
    assert queue.retry_delay(1).total_seconds() == 30
    assert queue.retry_delay(2).total_seconds() == 60
    assert queue.retry_delay(20).total_seconds() == queue.RETRY_MAX_SECONDS
