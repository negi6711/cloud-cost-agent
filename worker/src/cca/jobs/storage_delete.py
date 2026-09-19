"""`storage.delete` job: remove an uploaded object after its database rows are gone.

The web app deletes rows first (so nothing can read the file any more), then tries to delete the
object. If that fails it enqueues this job so the object is removed eventually, with retries.
"""

from __future__ import annotations

from collections.abc import Callable

import structlog

from cca.db import Connection
from cca.jobs.errors import PermanentJobError, RetryableJobError
from cca.jobs.queue import Job
from cca.storage import InvalidStorageKeyError, ObjectStore, key_belongs_to_tenant

log = structlog.get_logger("cca.jobs.storage_delete")


def make_storage_delete_handler(store: ObjectStore) -> Callable[[Connection, Job], None]:
    def handle(_conn: Connection, job: Job) -> None:
        key = str(job.payload.get("storageKey", ""))
        # A job may only delete objects under its own tenant's prefix.
        if not key_belongs_to_tenant(key, str(job.tenant_id)):
            raise PermanentJobError("storage key does not belong to the job's tenant")
        try:
            store.delete(key)
        except InvalidStorageKeyError as exc:
            raise PermanentJobError("invalid storage key") from exc
        except Exception as exc:
            raise RetryableJobError("object deletion failed") from exc
        log.info("storage.object_deleted", job_id=str(job.id))

    return handle
