from __future__ import annotations

import hashlib
import os
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import DictRow, dict_row
from psycopg.types.json import Jsonb

from cca.db import Connection, connect
from cca.settings import REPO_ROOT, Settings


def _load_dotenv(path: Path) -> None:
    """Minimal .env reader for test-only variables (TEST_DATABASE_*); never overrides the environment."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_dotenv(REPO_ROOT / ".env")

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "")
TEST_DATABASE_MIGRATION_URL = os.environ.get("TEST_DATABASE_MIGRATION_URL", "")
TEST_SECRET = "k" * 40


@pytest.fixture
def storage_dir(tmp_path: Path) -> Path:
    d = tmp_path / "storage"
    d.mkdir()
    return d


@pytest.fixture
def settings(storage_dir: Path) -> Settings:
    return Settings(
        DATABASE_URL=TEST_DATABASE_URL,
        WORKER_SHARED_SECRET=TEST_SECRET,
        STORAGE_DRIVER="local",
        LOCAL_STORAGE_DIR=storage_dir,
        WORKER_ID="worker-test",
        WORKER_LEASE_SECONDS=60,
    )


@pytest.fixture
def owner() -> Iterator[psycopg.Connection[DictRow]]:
    """Schema-owner connection (bypasses RLS) for seeding and inspection only."""
    with psycopg.connect(TEST_DATABASE_MIGRATION_URL, row_factory=dict_row, autocommit=True) as conn:
        conn.execute("TRUNCATE tenant, audit_event CASCADE")
        yield conn


@pytest.fixture
def app_conn(settings: Settings) -> Iterator[Connection]:
    """Connection as cca_app, the role the worker uses in production."""
    with connect(settings.database_url) as conn:
        yield conn


@dataclass
class Seeded:
    tenant_id: uuid.UUID
    lead_id: uuid.UUID
    source_file_id: uuid.UUID
    run_id: uuid.UUID
    job_id: uuid.UUID
    storage_key: str
    content: bytes


CSV = b"Service,Amazon EC2($),Total costs($)\nService total,300,300\n2026-07-01,100,100\n2026-08-01,200,200\n"


@pytest.fixture
def seed(owner: psycopg.Connection[DictRow], storage_dir: Path):  # type: ignore[no-untyped-def]
    def _seed(
        content: bytes = CSV, *, write_file: bool = True, max_attempts: int = 3, consent_basis: str | None = None
    ) -> Seeded:
        tenant_id, lead_id, file_id, run_id, job_id = (uuid.uuid4() for _ in range(5))
        key = f"uploads/{tenant_id}/{uuid.uuid4()}"
        owner.execute("INSERT INTO tenant (id, tenant_id, name) VALUES (%s, %s, 'T')", (tenant_id, tenant_id))
        owner.execute(
            "INSERT INTO lead (id, tenant_id, email, first_name, company_name, company_website, company_domain, "
            "role, country, provider, spend_band, biggest_problem, contact_permission, consent_or_contact_basis) "
            "VALUES (%s, %s, 'a@b.co', 'A', 'B', 'b.co', 'b.co', 'CTO', 'US', 'AWS', 'not_sure', 'x', true, 't')",
            (lead_id, tenant_id),
        )
        owner.execute(
            "INSERT INTO source_file (id, tenant_id, lead_id, storage_key, original_filename, mime_type, size_bytes, "
            "sha256, status, idempotency_key) VALUES (%s, %s, %s, %s, 'c.csv', 'text/csv', %s, %s, 'accepted', %s)",
            (file_id, tenant_id, lead_id, key, len(content), hashlib.sha256(content).hexdigest(), str(uuid.uuid4())),
        )
        owner.execute(
            "INSERT INTO snapshot_run (id, tenant_id, source_file_id, parser_version, status, question_set_version, "
            "consent_basis) VALUES (%s, %s, %s, 'ce-csv/1', 'queued', 'jev-qs/1', %s)",
            (run_id, tenant_id, file_id, consent_basis),
        )
        owner.execute(
            "INSERT INTO job (id, tenant_id, kind, idempotency_key, payload, max_attempts) "
            "VALUES (%s, %s, 'snapshot.process', %s, %s, %s)",
            (job_id, tenant_id, f"snapshot.process:{run_id}",
             Jsonb({"snapshotRunId": str(run_id), "sourceFileId": str(file_id)}), max_attempts),
        )
        if write_file:
            path = storage_dir.joinpath(*key.split("/"))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        return Seeded(tenant_id, lead_id, file_id, run_id, job_id, key, content)

    return _seed
