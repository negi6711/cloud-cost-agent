from __future__ import annotations

import re
import time

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from cca.service import create_app, kick_signature, verify_kick
from cca.settings import REPO_ROOT, Settings
from cca.versions import PARSER_VERSION, QUESTION_SET_VERSION

SECRET = "k" * 40


def test_healthz(settings: Settings) -> None:
    with TestClient(create_app(settings, start_loop=False)) as client:
        assert client.get("/healthz").json() == {"status": "ok"}


def test_kick_requires_a_fresh_valid_signature(settings: Settings) -> None:
    now = int(time.time())
    with TestClient(create_app(settings, start_loop=False)) as client:
        assert client.post("/internal/kick").status_code == 401
        bad = {"x-cca-timestamp": str(now), "x-cca-signature": "0" * 64}
        assert client.post("/internal/kick", headers=bad).status_code == 401
        stale = {"x-cca-timestamp": str(now - 3600), "x-cca-signature": kick_signature(settings.worker_shared_secret, now - 3600)}
        assert client.post("/internal/kick", headers=stale).status_code == 401
        good = {"x-cca-timestamp": str(now), "x-cca-signature": kick_signature(settings.worker_shared_secret, now)}
        assert client.post("/internal/kick", headers=good).status_code == 202


def test_no_other_routes_are_exposed(settings: Settings) -> None:
    with TestClient(create_app(settings, start_loop=False)) as client:
        for path in ("/docs", "/openapi.json", "/redoc"):
            assert client.get(path).status_code == 404


def test_verify_kick_rejects_malformed_timestamps() -> None:
    assert not verify_kick(SECRET, "abc", "x", 300, time.time())
    assert not verify_kick(SECRET, None, None, 300, time.time())


def test_signature_matches_the_web_implementation() -> None:
    """apps/web/lib/worker-kick.ts signs HMAC-SHA256(secret, `${ts}.kick`) as hex; so must we."""
    source = (REPO_ROOT / "apps/web/lib/worker-kick.ts").read_text(encoding="utf-8")
    assert '.update(`${timestamp}.kick`).digest("hex")' in source
    # Vector produced by Node: createHmac("sha256", "s").update("1.kick").digest("hex")
    assert kick_signature("s", 1) == "196e16cc9c36c425a5c016607eda104b57c3e8529b71faaaeaf222d303746983"


def test_versions_match_the_web_config() -> None:
    source = (REPO_ROOT / "packages/config/src/index.ts").read_text(encoding="utf-8")
    assert re.search(rf'PARSER_VERSION = "{re.escape(PARSER_VERSION)}"', source)
    assert re.search(rf'QUESTION_SET_VERSION = "{re.escape(QUESTION_SET_VERSION)}"', source)


def test_hosted_environments_refuse_local_storage(tmp_path) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(ValidationError, match="not allowed when hosted"):
        Settings(
            APP_ENV="production",
            DATABASE_URL="postgresql://x",
            WORKER_SHARED_SECRET=SECRET,
            STORAGE_DRIVER="local",
            LOCAL_STORAGE_DIR=tmp_path,
        )
