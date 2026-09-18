from __future__ import annotations

from pathlib import Path

import pytest

from cca.db import Connection
from cca.jobs.runner import Runner
from cca.settings import Settings
from cca.snapshots.process import make_handler
from cca.storage import InvalidStorageKeyError, LocalObjectStore


def runner(app_conn: Connection, storage_dir: Path, settings: Settings) -> Runner:
    handler = make_handler(LocalObjectStore(storage_dir), settings.upload_max_bytes)
    return Runner(app_conn, {"snapshot.process": handler}, "w", 60)


def test_verified_file_moves_run_to_parsing_and_job_succeeds(seed, owner, app_conn, storage_dir, settings) -> None:  # type: ignore[no-untyped-def]
    s = seed()
    assert runner(app_conn, storage_dir, settings).drain() == 1
    run = owner.execute("SELECT status FROM snapshot_run WHERE id = %s", (s.run_id,)).fetchone()
    job = owner.execute("SELECT status, attempts FROM job WHERE id = %s", (s.job_id,)).fetchone()
    assert run == {"status": "parsing"}
    assert job == {"status": "succeeded", "attempts": 1}


def test_tampered_file_fails_permanently_with_a_visible_warning(seed, owner, app_conn, storage_dir, settings) -> None:  # type: ignore[no-untyped-def]
    s = seed()
    storage_dir.joinpath(*s.storage_key.split("/")).write_bytes(b"Service,X\n2026-07-01,999\n")
    runner(app_conn, storage_dir, settings).drain()
    run = owner.execute("SELECT status, warnings, completed_at FROM snapshot_run WHERE id = %s", (s.run_id,)).fetchone()
    job = owner.execute("SELECT status, last_error_class FROM job WHERE id = %s", (s.job_id,)).fetchone()
    assert run["status"] == "failed" and run["completed_at"] is not None
    assert run["warnings"] == [{"code": "integrity_mismatch", "stage": "load"}]
    assert job == {"status": "dead", "last_error_class": "IntegrityError"}


def test_missing_object_is_retried_not_failed(seed, owner, app_conn, storage_dir, settings) -> None:  # type: ignore[no-untyped-def]
    s = seed(write_file=False)
    runner(app_conn, storage_dir, settings).drain()
    job = owner.execute("SELECT status, last_error_class FROM job WHERE id = %s", (s.job_id,)).fetchone()
    run = owner.execute("SELECT status FROM snapshot_run WHERE id = %s", (s.run_id,)).fetchone()
    assert job == {"status": "queued", "last_error_class": "RetryableJobError"}
    assert run == {"status": "queued"}


def test_unknown_job_kind_is_dead_not_retried(seed, owner, app_conn) -> None:  # type: ignore[no-untyped-def]
    s = seed()
    owner.execute("UPDATE job SET kind = 'mystery' WHERE id = %s", (s.job_id,))
    Runner(app_conn, {}, "w", 60).drain()
    job = owner.execute("SELECT status, last_error_class FROM job WHERE id = %s", (s.job_id,)).fetchone()
    assert job == {"status": "dead", "last_error_class": "UnknownJobKind"}


@pytest.mark.parametrize(
    "key",
    ["../../etc/passwd", "uploads/../../x", "uploads/a/b", "/abs/path", "uploads/00000000-0000-0000-0000-000000000000/.."],
)
def test_storage_rejects_keys_outside_our_shape(tmp_path: Path, key: str) -> None:
    with pytest.raises(InvalidStorageKeyError):
        LocalObjectStore(tmp_path).path_for(key)
