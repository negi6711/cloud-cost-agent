"""Database access for the worker.

The worker connects as `cca_app`, the same non-owner role as the web app, so row-level security
applies to it too. All tenant data is touched inside `tenant_transaction`, which declares the
tenant for that transaction. Cross-tenant work is limited to the SECURITY DEFINER functions
`claim_next_job` and `reap_exhausted_jobs`.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID

import psycopg
from psycopg.rows import DictRow, dict_row

Connection = psycopg.Connection[DictRow]

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def connect(database_url: str) -> Connection:
    # prepare_threshold=None: no server-side prepared statements, which transaction-mode poolers
    # (Supabase's pooler) cannot carry across transactions.
    local = any(h in database_url for h in ("@localhost", "@127.0.0.1"))
    # Hosted databases must use TLS; libpq's default ("prefer") would silently accept plaintext.
    return psycopg.connect(
        database_url,
        row_factory=dict_row,
        autocommit=True,
        prepare_threshold=None,
        sslmode="prefer" if local else "require",
    )


@contextmanager
def tenant_transaction(conn: Connection, tenant_id: UUID | str) -> Iterator[Connection]:
    """Run a block in a transaction scoped to one tenant by RLS."""
    tenant = str(tenant_id)
    if not _UUID_RE.match(tenant):
        raise ValueError("tenant_id must be a UUID")
    with conn.transaction():
        conn.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant,))
        yield conn
