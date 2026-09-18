from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import DictRow

from cca.db import Connection
from cca.jobs.runner import Runner
from cca.settings import REPO_ROOT, Settings
from cca.snapshots.process import make_handler
from cca.storage import InvalidStorageKeyError, LocalObjectStore

TODAY = date(2026, 9, 18)
FIXTURES = REPO_ROOT / "fixtures"


def runner(app_conn: Connection, storage_dir: Path, settings: Settings) -> Runner:
    handler = make_handler(LocalObjectStore(storage_dir), settings.upload_max_bytes, lambda: TODAY)
    return Runner(app_conn, {"snapshot.process": handler}, "w", 60)


Owner = psycopg.Connection[DictRow]


def _one(owner: Owner, sql: str, key: object) -> DictRow:
    row = owner.execute(sql, (key,)).fetchone()
    assert row is not None
    return row


def run_row(owner: Owner, run_id: object) -> DictRow:
    return _one(owner, "SELECT * FROM snapshot_run WHERE id = %s", run_id)


def job_row(owner: Owner, job_id: object) -> DictRow:
    return _one(owner, "SELECT status, attempts, last_error_class FROM job WHERE id = %s", job_id)


def file_row(owner: Owner, file_id: object) -> DictRow:
    return _one(
        owner,
        "SELECT status, dimension, detected_period_start, detected_period_end FROM source_file WHERE id = %s",
        file_id,
    )


def test_valid_export_is_parsed_and_recorded(seed, owner, app_conn, storage_dir, settings) -> None:  # type: ignore[no-untyped-def]
    s = seed((FIXTURES / "valid_cost_explorer.csv").read_bytes())
    assert runner(app_conn, storage_dir, settings).drain() == 1

    run = run_row(owner, s.run_id)
    assert run["status"] == "completed" and run["completed_at"] is not None
    assert (run["rows_seen"], run["rows_accepted"], run["rows_rejected"]) == (3, 3, 0)
    assert (run["total_cost"], run["currency"]) == (Decimal("23013.75"), "USD")
    assert run["data_readiness_score"] == 85
    assert run["summary"]["comparison"]["current_month"] == "2026-07"
    assert run["explanation_provider"] == "template"
    assert run["evidence_packet_version"] == "ep/1" and len(run["evidence_packet_sha256"]) == 64
    # Seeded runs have no consent: classification is unavailable and says why.
    assert run["model_status"] == "JEV_UNAVAILABLE_REVIEW_REQUIRED"

    findings = owner.execute(
        "SELECT rank, kind, final_category, category, jev_category, review_required, policy_reasons, model_status, "
        "title, next_action, evidence, missing_evidence, observed_value FROM snapshot_finding "
        "WHERE snapshot_run_id = %s ORDER BY rank", (s.run_id,)).fetchall()
    assert [(f["rank"], f["kind"], f["final_category"]) for f in findings] == [
        (1, "new_service", "REQUEST_EVIDENCE"), (2, "material_increase", "MONITOR")]
    ecs = findings[0]
    assert ecs["category"] == ecs["final_category"] and ecs["jev_category"] is None
    assert ecs["review_required"] and ecs["policy_reasons"] == ["classification_unavailable:no_consent"]
    assert ecs["observed_value"] == Decimal("1840.00")
    assert ecs["title"] == "New service: Amazon Elastic Container Service"
    assert {"text": "Billing data shows $1,840.00 in July 2026.", "refs": ["L5:C7"]} in ecs["evidence"]
    assert ecs["missing_evidence"][0]["code"] == "owner_confirmation"

    packets = owner.execute(
        "SELECT evidence_id, version, sha256, packet FROM evidence_packet WHERE snapshot_run_id = %s", (s.run_id,)
    ).fetchall()
    assert len(packets) == 2 and all(p["version"] == "ep/1" for p in packets)
    assert owner.execute("SELECT count(*) AS n FROM model_call").fetchone() == {"n": 0}  # nothing was sent
    assert file_row(owner, s.source_file_id) == {
        "status": "processed",
        "dimension": "service",
        "detected_period_start": date(2026, 5, 1),
        "detected_period_end": date(2026, 7, 31),
    }
    assert job_row(owner, s.job_id) == {"status": "succeeded", "attempts": 1, "last_error_class": None}


def test_data_quality_issues_are_recorded_without_file_contents(seed, owner, app_conn, storage_dir, settings) -> None:  # type: ignore[no-untyped-def]
    s = seed((FIXTURES / "invalid_numeric.csv").read_bytes())
    runner(app_conn, storage_dir, settings).drain()
    run = run_row(owner, s.run_id)
    by_code = {w["code"]: w for w in run["warnings"]}
    assert by_code["rows_rejected"]["count"] == 3
    assert by_code["rows_rejected"]["detail"] == {"by_reason": {"invalid_number": 3}}
    assert {w["severity"] for w in run["warnings"]} <= {"info", "warning", "error"}
    stored = str(run["warnings"])
    for raw in ("N/A", "abc", "1.2.3", "Amazon Relational Database Service"):
        assert raw not in stored


def test_hostile_labels_never_reach_stored_issues(seed, owner, app_conn, storage_dir, settings) -> None:  # type: ignore[no-untyped-def]
    s = seed((FIXTURES / "prompt_injection_labels.csv").read_bytes())
    runner(app_conn, storage_dir, settings).drain()
    run = run_row(owner, s.run_id)
    assert run["status"] == "completed"
    assert "Ignore previous instructions" not in str(run["warnings"])
    packets = owner.execute("SELECT packet FROM evidence_packet WHERE snapshot_run_id = %s", (s.run_id,)).fetchall()
    assert packets and "Ignore previous instructions" not in str([p["packet"] for p in packets])


def test_single_month_export_abstains_with_a_reason(seed, owner, app_conn, storage_dir, settings) -> None:  # type: ignore[no-untyped-def]
    s = seed(b"Service,EC2($)\n2026-07-01,100\n")
    runner(app_conn, storage_dir, settings).drain()
    run = run_row(owner, s.run_id)
    assert run["status"] == "insufficient_data" and run["completed_at"] is not None
    abstain = next(w for w in run["warnings"] if w["code"] == "no_comparison")
    assert abstain["severity"] == "error" and "two consecutive complete months" in abstain["message"]
    assert owner.execute("SELECT count(*) AS n FROM snapshot_finding").fetchone() == {"n": 0}


def test_retrying_a_completed_run_changes_nothing(seed, owner, app_conn, storage_dir, settings) -> None:  # type: ignore[no-untyped-def]
    s = seed((FIXTURES / "valid_cost_explorer.csv").read_bytes())
    runner(app_conn, storage_dir, settings).drain()
    owner.execute("UPDATE job SET status = 'queued', run_after = now() WHERE id = %s", (s.job_id,))
    runner(app_conn, storage_dir, settings).drain()
    assert owner.execute("SELECT count(*) AS n FROM snapshot_finding").fetchone() == {"n": 2}
    assert owner.execute("SELECT count(*) AS n FROM evidence_packet").fetchone() == {"n": 2}


def test_unusable_file_ends_the_run_with_an_actionable_message(seed, owner, app_conn, storage_dir, settings) -> None:  # type: ignore[no-untyped-def]
    s = seed((FIXTURES / "malformed_missing_cost.csv").read_bytes())
    runner(app_conn, storage_dir, settings).drain()
    run = run_row(owner, s.run_id)
    assert run["status"] == "failed" and run["completed_at"] is not None
    [issue] = run["warnings"]
    assert (issue["code"], issue["severity"], issue["stage"]) == ("missing_required_columns", "error", "parse")
    assert "cost" in issue["message"]
    assert file_row(owner, s.source_file_id)["status"] == "failed"
    # The data was bad, the job was not: no retries.
    assert job_row(owner, s.job_id) == {"status": "succeeded", "attempts": 1, "last_error_class": None}


def test_reprocessing_the_same_run_is_a_no_op_once_finished(seed, owner, app_conn, storage_dir, settings) -> None:  # type: ignore[no-untyped-def]
    s = seed((FIXTURES / "malformed_missing_cost.csv").read_bytes())
    runner(app_conn, storage_dir, settings).drain()
    before = run_row(owner, s.run_id)
    owner.execute("UPDATE job SET status = 'queued', run_after = now() WHERE id = %s", (s.job_id,))
    runner(app_conn, storage_dir, settings).drain()
    assert run_row(owner, s.run_id)["warnings"] == before["warnings"]  # not appended twice


def test_tampered_file_fails_permanently_with_a_visible_warning(seed, owner, app_conn, storage_dir, settings) -> None:  # type: ignore[no-untyped-def]
    s = seed()
    storage_dir.joinpath(*s.storage_key.split("/")).write_bytes(b"Service,X\n2026-07-01,999\n")
    runner(app_conn, storage_dir, settings).drain()
    run = run_row(owner, s.run_id)
    assert run["status"] == "failed" and run["completed_at"] is not None
    [issue] = run["warnings"]
    assert (issue["code"], issue["severity"], issue["stage"]) == ("integrity_mismatch", "error", "load")
    assert job_row(owner, s.job_id)["status"] == "dead"


def test_missing_object_is_retried_not_failed(seed, owner, app_conn, storage_dir, settings) -> None:  # type: ignore[no-untyped-def]
    s = seed(write_file=False)
    runner(app_conn, storage_dir, settings).drain()
    assert job_row(owner, s.job_id) == {"status": "queued", "attempts": 1, "last_error_class": "RetryableJobError"}
    assert run_row(owner, s.run_id)["status"] == "queued"


def test_unknown_job_kind_is_dead_not_retried(seed, owner, app_conn) -> None:  # type: ignore[no-untyped-def]
    s = seed()
    owner.execute("UPDATE job SET kind = 'mystery' WHERE id = %s", (s.job_id,))
    Runner(app_conn, {}, "w", 60).drain()
    assert job_row(owner, s.job_id) == {"status": "dead", "attempts": 1, "last_error_class": "UnknownJobKind"}


@pytest.mark.parametrize(
    "key",
    ["../../etc/passwd", "uploads/../../x", "uploads/a/b", "/abs/path", "uploads/00000000-0000-0000-0000-000000000000/.."],
)
def test_storage_rejects_keys_outside_our_shape(tmp_path: Path, key: str) -> None:
    with pytest.raises(InvalidStorageKeyError):
        LocalObjectStore(tmp_path).path_for(key)
