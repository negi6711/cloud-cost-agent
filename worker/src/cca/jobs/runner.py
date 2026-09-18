"""Claims jobs and dispatches them to handlers."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass

import structlog

from cca.db import Connection
from cca.jobs import queue
from cca.jobs.errors import PermanentJobError, RetryableJobError
from cca.jobs.queue import Job

log = structlog.get_logger("cca.jobs")

Handler = Callable[[Connection, Job], None]


@dataclass
class Runner:
    conn: Connection
    handlers: Mapping[str, Handler]
    worker_id: str
    lease_seconds: int

    def run_once(self) -> bool:
        """Process at most one job. Returns False when the queue had nothing runnable."""
        job = queue.claim(self.conn, self.worker_id, self.lease_seconds)
        if job is None:
            return False
        bound = log.bind(job_id=str(job.id), kind=job.kind, attempt=job.attempts)
        handler = self.handlers.get(job.kind)
        if handler is None:
            queue.mark_failed(self.conn, job, "UnknownJobKind", retryable=False)
            bound.error("job.unknown_kind")
            return True
        try:
            handler(self.conn, job)
        except RetryableJobError as exc:
            status = queue.mark_failed(self.conn, job, type(exc).__name__, retryable=True)
            bound.warning("job.retryable_failure", error_class=type(exc).__name__, new_status=status)
        except PermanentJobError as exc:
            queue.mark_failed(self.conn, job, type(exc).__name__, retryable=False)
            bound.error("job.permanent_failure", error_class=type(exc).__name__)
        except Exception as exc:  # noqa: BLE001 - unknown failures are retried; they may be transient
            status = queue.mark_failed(self.conn, job, type(exc).__name__, retryable=True)
            bound.exception("job.unexpected_failure", error_class=type(exc).__name__, new_status=status)
        else:
            queue.mark_succeeded(self.conn, job)
            bound.info("job.succeeded")
        return True

    def drain(self, limit: int = 100) -> int:
        """Process runnable jobs until the queue is empty (or `limit` jobs). Returns jobs processed."""
        queue.reap_exhausted(self.conn)
        processed = 0
        while processed < limit and self.run_once():
            processed += 1
        return processed
