from __future__ import annotations

import uuid
from typing import Any

from cca.db import Connection
from cca.jobs.queue import Job
from cca.jobs.runner import Runner
from cca.jobs.storage_delete import make_storage_delete_handler
from cca.retention import sweep
from cca.settings import Settings
from cca.snapshots.process import make_handler
from cca.storage import LocalObjectStore


def age(owner: Any, file_id: object, days: int) -> None:
    owner.execute("UPDATE source_file SET created_at = now() - make_interval(days => %s) WHERE id = %s", (days, file_id))


def test_sweep_deletes_only_expired_raw_files_and_keeps_derived_data(seed, owner, app_conn, storage_dir) -> None:  # type: ignore[no-untyped-def]
    old, fresh = seed(), seed()
    age(owner, old.source_file_id, 31)
    store = LocalObjectStore(storage_dir)

    result = sweep(app_conn, store, retention_days=30)
    assert (result.deleted, result.failed) == (1, 0)
    assert not storage_dir.joinpath(*old.storage_key.split("/")).exists()
    assert storage_dir.joinpath(*fresh.storage_key.split("/")).exists()

    rows = {r["id"]: r for r in owner.execute("SELECT id, raw_deleted_at FROM source_file").fetchall()}
    assert rows[old.source_file_id]["raw_deleted_at"] is not None
    assert rows[fresh.source_file_id]["raw_deleted_at"] is None
    # The run, and anything derived from it, stays until someone deletes the file.
    assert owner.execute("SELECT count(*) AS n FROM snapshot_run WHERE id = %s", (old.run_id,)).fetchone() == {"n": 1}
    audit = owner.execute("SELECT actor_type, action FROM audit_event WHERE object_id = %s",
                          (str(old.source_file_id),)).fetchall()
    assert audit == [{"actor_type": "system", "action": "raw_file.deleted_by_retention"}]

    assert sweep(app_conn, store, retention_days=30).deleted == 0  # idempotent


def test_a_run_whose_raw_file_expired_ends_with_a_clear_message(seed, owner, app_conn, storage_dir) -> None:  # type: ignore[no-untyped-def]
    s = seed()
    age(owner, s.source_file_id, 40)
    sweep(app_conn, LocalObjectStore(storage_dir), retention_days=30)
    handler = make_handler(LocalObjectStore(storage_dir), 1024 * 1024)
    Runner(app_conn, {"snapshot.process": handler}, "w", 60).drain()
    run = owner.execute("SELECT status, warnings FROM snapshot_run WHERE id = %s", (s.run_id,)).fetchone()
    assert run["status"] == "failed" and run["warnings"][0]["code"] == "raw_file_deleted"


def _job(tenant: object, key: str) -> Job:
    return Job(uuid.uuid4(), uuid.UUID(str(tenant)), "storage.delete", {"storageKey": key}, 1, 3)


def test_storage_delete_job_is_idempotent_and_tenant_bound(seed, app_conn: Connection, storage_dir) -> None:  # type: ignore[no-untyped-def]
    import pytest

    from cca.jobs.errors import PermanentJobError

    s = seed()
    handle = make_storage_delete_handler(LocalObjectStore(storage_dir))
    handle(app_conn, _job(s.tenant_id, s.storage_key))
    assert not storage_dir.joinpath(*s.storage_key.split("/")).exists()
    handle(app_conn, _job(s.tenant_id, s.storage_key))  # already gone: still fine

    other = seed()
    with pytest.raises(PermanentJobError):
        handle(app_conn, _job(s.tenant_id, other.storage_key))  # another tenant's object
    assert storage_dir.joinpath(*other.storage_key.split("/")).exists()


def test_settings_default_retention_is_thirty_days(settings: Settings) -> None:
    assert settings.raw_file_retention_days == 30
