"""HTTP shell around the job loop.

Runs as a Render web service so the same code works on the free plan (the web app's kick wakes a
sleeping instance) and on paid plans (always on, also polling). Only two endpoints exist:
`GET /healthz` and `POST /internal/kick`, which is authenticated with an HMAC over a timestamp.
"""

from __future__ import annotations

import hashlib
import hmac
import threading
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Header, HTTPException, Response

from cca.db import connect
from cca.jobs.runner import Handler, Runner
from cca.settings import Settings
from cca.snapshots.process import make_handler, unavailable_provider_factory
from cca.storage import object_store

log = structlog.get_logger("cca.service")


def kick_signature(secret: str, timestamp: int) -> str:
    """Must match apps/web/lib/worker-kick.ts."""
    return hmac.new(secret.encode(), f"{timestamp}.kick".encode(), hashlib.sha256).hexdigest()


def verify_kick(secret: str, timestamp: str | None, signature: str | None, max_skew: int, now: float) -> bool:
    if not timestamp or not signature or not timestamp.isdigit():
        return False
    ts = int(timestamp)
    if abs(now - ts) > max_skew:
        return False
    return hmac.compare_digest(kick_signature(secret, ts), signature)


class JobLoop:
    """Background thread: drain the queue, then sleep until kicked or the poll interval passes."""

    def __init__(self, settings: Settings, handlers_factory: Callable[[], dict[str, Handler]]) -> None:
        self._settings = settings
        self._handlers_factory = handlers_factory
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="job-loop", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=10)

    def kick(self) -> None:
        self._wake.set()

    def _run(self) -> None:
        handlers = self._handlers_factory()
        while not self._stop.is_set():
            try:
                with connect(self._settings.database_url) as conn:
                    runner = Runner(conn, handlers, self._settings.worker_id, self._settings.lease_seconds)
                    while not self._stop.is_set():
                        processed = runner.drain()
                        if processed:
                            log.info("loop.drained", jobs=processed)
                        self._wake.wait(self._settings.poll_interval_seconds)
                        self._wake.clear()
            except Exception as exc:  # keep the loop alive across DB outages (logged, then retried)
                log.exception("loop.error", error_class=type(exc).__name__)
                self._stop.wait(5)


def default_handlers(settings: Settings) -> dict[str, Handler]:
    store = object_store(settings)
    return {
        "snapshot.process": make_handler(
            store,
            settings.upload_max_bytes,
            providers=unavailable_provider_factory(settings.jev_enabled),
            low_confidence=settings.jev_low_confidence_threshold,
        )
    }


def create_app(settings: Settings, *, start_loop: bool = True) -> FastAPI:
    loop = JobLoop(settings, lambda: default_handlers(settings))

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if start_loop:
            loop.start()
        try:
            yield
        finally:
            if start_loop:
                loop.stop()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/internal/kick", status_code=202)
    def kick(
        x_cca_timestamp: str | None = Header(default=None),
        x_cca_signature: str | None = Header(default=None),
    ) -> Response:
        if not verify_kick(
            settings.worker_shared_secret,
            x_cca_timestamp,
            x_cca_signature,
            settings.kick_max_skew_seconds,
            time.time(),
        ):
            raise HTTPException(status_code=401, detail="unauthorized")
        loop.kick()
        return Response(status_code=202)

    return app
