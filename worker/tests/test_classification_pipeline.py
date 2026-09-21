from __future__ import annotations

import ast
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from cca.db import Connection, tenant_transaction
from cca.jobs.runner import Runner
from cca.providers.base import (
    CallRecord,
    ClassificationOutcome,
    DecisionModelProvider,
    UnavailableProvider,
    UnavailableReason,
)
from cca.providers.cache import CachingProvider, load_cached_answers
from cca.providers.factory import provider_factory
from cca.providers.jev import JevProvider
from cca.providers.jev_answers import validate_answers
from cca.providers.mock import MockJevProvider, mock_answers
from cca.settings import REPO_ROOT, Settings
from cca.snapshots.process import make_handler
from cca.storage import LocalObjectStore

TODAY = date(2026, 9, 18)
CSV = (REPO_ROOT / "fixtures" / "valid_cost_explorer.csv").read_bytes()
GRANTED = "typesafe:granted"


def runner(app_conn: Connection, storage_dir: Path, factory: Any) -> Runner:
    handler = make_handler(LocalObjectStore(storage_dir), 25 * 1024 * 1024, lambda: TODAY, providers=factory)
    return Runner(app_conn, {"snapshot.process": handler}, "w", 60)


@dataclass
class Recording:
    """A provider stub that records calls and returns scripted outcomes."""

    outcomes: list[str]  # per call: "ok" | "transient"
    name: str = "typesafe"
    model: str = "jev-1.13.0"
    calls: list[str] = field(default_factory=list)

    def classify(self, packet: dict[str, Any], packet_sha256: str) -> ClassificationOutcome:
        mode = self.outcomes[min(len(self.calls), len(self.outcomes) - 1)]
        self.calls.append(packet_sha256)
        if mode == "transient":
            record = CallRecord(self.name, self.model, None, "req_fail", "jev-qs/1", packet_sha256, "failed", 1, 5,
                                None, None, "TypeSafeRateLimitError")
            return ClassificationOutcome(None, UnavailableReason.EXHAUSTED, True, [record])
        answers = mock_answers(packet)
        record = CallRecord(self.name, self.model, self.model, "req_ok", "jev-qs/1", packet_sha256, "succeeded", 1, 5,
                            321, answers, None)
        return ClassificationOutcome(validate_answers(answers), None, False, [record])


def fixed(p: DecisionModelProvider) -> Any:
    return lambda consent, attempt: p if consent == GRANTED else UnavailableProvider(UnavailableReason.NO_CONSENT)


def findings(owner: Any, run_id: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = owner.execute(
        "SELECT rank, rule_category, jev_category, jev_owner, jev_confidence, final_category, model_status, policy_status, "
        "policy_reasons, review_required, owner FROM snapshot_finding WHERE snapshot_run_id = %s ORDER BY rank",
        (run_id,)).fetchall()
    return rows


def test_consented_run_is_classified_and_every_call_recorded(seed, owner, app_conn, storage_dir) -> None:  # type: ignore[no-untyped-def]
    s = seed(CSV, consent_basis=GRANTED)
    stub = Recording(["ok"])
    runner(app_conn, storage_dir, fixed(stub)).drain()

    run = owner.execute("SELECT status, model_status, model_provider, model_identifier FROM snapshot_run "
                        "WHERE id = %s", (s.run_id,)).fetchone()
    assert run == {"status": "completed", "model_status": "JEV_SUCCEEDED", "model_provider": "typesafe",
                   "model_identifier": "jev-1.13.0"}
    rows = findings(owner, s.run_id)
    # Our rules publish the category; the model's answer is stored beside it, agreeing or not.
    assert [(r["rule_category"], r["jev_category"], r["final_category"], r["policy_status"]) for r in rows] == [
        ("REQUEST_EVIDENCE", "REQUEST_EVIDENCE", "REQUEST_EVIDENCE", "PASSED"),  # new ECS service: agreed
        ("MONITOR", "INVESTIGATE", "MONITOR", "POLICY_BLOCKED"),  # Tax: the model wanted more, recorded only
    ]
    assert all(r["model_status"] == "JEV_SUCCEEDED" for r in rows)
    assert rows[0]["owner"] == "Platform / Infrastructure" and rows[0]["jev_owner"] == "platform_infrastructure"
    assert len(stub.calls) == 2

    calls = owner.execute("SELECT provider, model_requested, model_reported, request_id, status, input_tokens, "
                          "question_set_version, answers FROM model_call ORDER BY evidence_id").fetchall()
    assert len(calls) == 2
    assert {(c["provider"], c["model_requested"], c["request_id"], c["status"]) for c in calls} == {
        ("typesafe", "jev-1.13.0", "req_ok", "succeeded")}
    assert all(c["answers"]["decision_category"]["type"] == "choice" for c in calls)


def test_declined_consent_never_reaches_the_provider(seed, owner, app_conn, storage_dir) -> None:  # type: ignore[no-untyped-def]
    s = seed(CSV, consent_basis="typesafe:declined")
    stub = Recording(["ok"])
    runner(app_conn, storage_dir, fixed(stub)).drain()
    assert stub.calls == []
    assert owner.execute("SELECT count(*) AS n FROM model_call").fetchone() == {"n": 0}
    rows = findings(owner, s.run_id)
    assert all(r["policy_reasons"] == ["classification_unavailable:no_consent"] for r in rows)
    assert all(r["jev_category"] is None and r["review_required"] for r in rows)


def test_transient_failures_retry_the_job_and_reuse_successful_answers(seed, owner, app_conn, storage_dir) -> None:  # type: ignore[no-untyped-def]
    s = seed(CSV, consent_basis=GRANTED)
    stub = Recording(["ok", "transient", "ok"])  # 2nd finding fails on attempt 1
    r = runner(app_conn, storage_dir, fixed(stub))
    r.drain()
    job = owner.execute("SELECT status, attempts, last_error_class FROM job WHERE id = %s", (s.job_id,)).fetchone()
    assert job == {"status": "queued", "attempts": 1, "last_error_class": "RetryableJobError"}
    run = owner.execute("SELECT status FROM snapshot_run WHERE id = %s", (s.run_id,)).fetchone()
    assert run == {"status": "classifying"}  # not shown as a finished snapshot
    assert owner.execute("SELECT count(*) AS n FROM snapshot_finding").fetchone() == {"n": 0}
    failed = owner.execute("SELECT status, error_class FROM model_call WHERE status = 'failed'").fetchall()
    assert failed == [{"status": "failed", "error_class": "TypeSafeRateLimitError"}]  # kept for the audit trail

    owner.execute("UPDATE job SET run_after = now() WHERE id = %s", (s.job_id,))
    r.drain()
    assert owner.execute("SELECT status FROM snapshot_run WHERE id = %s", (s.run_id,)).fetchone() == {
        "status": "completed"}
    # Attempt 2 re-asked only the finding that failed: the first answer came from the cache.
    assert len(stub.calls) == 3


def test_exhausted_retries_complete_with_review_required(seed, owner, app_conn, storage_dir) -> None:  # type: ignore[no-untyped-def]
    s = seed(CSV, consent_basis=GRANTED, max_attempts=1)
    runner(app_conn, storage_dir, fixed(Recording(["transient"]))).drain()
    run = owner.execute("SELECT status, model_status FROM snapshot_run WHERE id = %s", (s.run_id,)).fetchone()
    assert run == {"status": "completed", "model_status": "JEV_UNAVAILABLE_REVIEW_REQUIRED"}
    rows = findings(owner, s.run_id)
    assert all(r["policy_reasons"][0] == "classification_unavailable:retries_exhausted" for r in rows)
    assert all(r["jev_category"] is None for r in rows)  # nothing was invented


def test_cached_answers_are_tenant_scoped_and_reused(seed, owner, app_conn, storage_dir) -> None:  # type: ignore[no-untyped-def]
    a = seed(CSV, consent_basis=GRANTED)
    runner(app_conn, storage_dir, fixed(Recording(["ok"]))).drain()
    b = seed(CSV, consent_basis=GRANTED)  # another tenant, same bytes

    with tenant_transaction(app_conn, a.tenant_id):
        cache_a = load_cached_answers(app_conn, "typesafe", "jev-1.13.0")
    with tenant_transaction(app_conn, b.tenant_id):
        cache_b = load_cached_answers(app_conn, "typesafe", "jev-1.13.0")
    assert len(cache_a) == 2 and cache_b == {}

    stub = Recording(["ok"])
    sha, answers = next(iter(cache_a.items()))
    outcome = CachingProvider(stub, cache_a).classify({"finding": {}}, sha)
    assert outcome.classification is not None and stub.calls == []
    assert outcome.calls[0].status == "cached"
    assert answers["decision_category"]["type"] == "choice"


# ---------------------------------------------------------------- factory ---


def settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {"DATABASE_URL": "postgresql://x", "WORKER_SHARED_SECRET": "k" * 40,
                            "STORAGE_DRIVER": "local", "LOCAL_STORAGE_DIR": Path.cwd().resolve(),
                            "TYPESAFE_API_KEY": None, "JEV_ENABLED": False, "JEV_PROVIDER": "mock"}
    # _env_file=None so the developer's .env (which may hold a real key) cannot change the outcome.
    return Settings(_env_file=None, **{**base, **overrides})


def test_factory_checks_consent_first_then_enablement_then_configuration() -> None:
    enabled_mock = provider_factory(settings(JEV_ENABLED=True, JEV_PROVIDER="mock"))
    no_consent = enabled_mock("typesafe:declined", 1)
    assert isinstance(no_consent, UnavailableProvider) and no_consent.reason is UnavailableReason.NO_CONSENT
    assert isinstance(enabled_mock(GRANTED, 1), MockJevProvider)

    disabled = provider_factory(settings(JEV_ENABLED=False))(GRANTED, 1)
    assert isinstance(disabled, UnavailableProvider) and disabled.reason is UnavailableReason.DISABLED

    no_key = provider_factory(settings(JEV_ENABLED=True, JEV_PROVIDER="typesafe"))(GRANTED, 1)
    assert isinstance(no_key, UnavailableProvider) and no_key.reason is UnavailableReason.NOT_CONFIGURED

    real = provider_factory(settings(JEV_ENABLED=True, JEV_PROVIDER="typesafe", TYPESAFE_API_KEY="key"))(GRANTED, 2)
    assert isinstance(real, JevProvider) and (real.model, real.attempt) == ("jev-1.13.0", 2)
    real.close()


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"JEV_PROVIDER": "mock"}, "mock is not allowed"),
        ({"JEV_PROVIDER": "typesafe", "JEV_MODEL": "jev-latest"}, "pinned version"),
    ],
)
def test_hosted_environments_require_real_pinned_jev(overrides: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        settings(APP_ENV="production", STORAGE_DRIVER="r2", R2_ACCOUNT_ID="a", R2_ACCESS_KEY_ID="b",
                 R2_SECRET_ACCESS_KEY="c", R2_BUCKET="d", **overrides)


def test_api_key_is_never_part_of_settings_repr() -> None:
    s = settings(TYPESAFE_API_KEY="super-secret-key")
    assert "super-secret-key" not in repr(s) and "super-secret-key" not in str(s.model_dump())


# ------------------------------------------------------------- invariants ---


def _imports(path: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


def test_only_the_provider_modules_import_the_typesafe_sdk() -> None:
    src = REPO_ROOT / "worker" / "src" / "cca"
    allowed = {src / "providers" / "jev.py", src / "providers" / "jev_questions_v1.py"}
    offenders = [p for p in src.rglob("*.py") if "typesafe_sdk" in _imports(p) and p not in allowed]
    assert offenders == []


def test_no_aws_api_client_outside_r2_storage() -> None:
    src = REPO_ROOT / "worker" / "src" / "cca"
    offenders = [p for p in src.rglob("*.py")
                 if {"boto3", "botocore", "aiobotocore"} & _imports(p) and p.parent.name != "storage"]
    assert offenders == []
    assert "r2.cloudflarestorage.com" in (src / "storage" / "__init__.py").read_text(encoding="utf-8")


# ----------------------------------------------------------------- replay ---


def test_replay_revalidates_stored_answers_without_the_raw_file(seed, owner, app_conn, storage_dir) -> None:  # type: ignore[no-untyped-def]
    from cca.replay import load, replay

    s = seed(CSV, consent_basis=GRANTED)
    runner(app_conn, storage_dir, fixed(Recording(["ok"]))).drain()
    storage_dir.joinpath(*s.storage_key.split("/")).unlink()  # the raw file is gone

    consent, rows = load(app_conn, s.tenant_id, s.run_id)
    assert consent == GRANTED and len(rows) == 2
    stored = replay(rows, None)
    assert [r.note for r in stored] == ["stored answer valid", "stored answer valid"]
    assert not any(r.changed for r in stored)

    live = replay(rows, MockJevProvider())
    assert all(r.replay_category is not None for r in live)
