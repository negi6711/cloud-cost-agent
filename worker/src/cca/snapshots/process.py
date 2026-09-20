"""The `snapshot.process` job: load -> parse -> analyze (detect, readiness, evidence packets,
model classification, policy gate, explanations) -> persist.

Runs in two phases, because uploads happen before the email gate:

* `teaser` (payload phase absent or "teaser"): deterministic only. The provider for a run whose
  consent is still "pending" is always unavailable, so no model call and no spend can happen before
  a visitor has given their email.
* `full` (payload phase "full"): enqueued when the report is unlocked. The same file is parsed
  again (deterministic, so the facts are identical) and classified according to the consent that was
  recorded at the gate. Findings are updated in place.

Parsed rows live only in memory for the duration of the job. What is persisted is aggregate:
counts, totals, the detected period, and issues whose messages are ours, never file contents.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

import structlog
from psycopg.types.json import Jsonb

from cca.db import Connection, tenant_transaction
from cca.jobs.errors import PermanentJobError, RetryableJobError
from cca.jobs.queue import Job
from cca.parsers import ParseError, ParseResult, parse_billing_export
from cca.providers.base import DecisionModelProvider, UnavailableProvider, UnavailableReason
from cca.providers.cache import CachingProvider, load_cached_answers
from cca.providers.factory import CONSENT_GRANTED, CONSENT_PENDING, ProviderFactory
from cca.snapshots.analyze import analyze
from cca.snapshots.explain import ExplanationProvider, TemplateExplanationProvider
from cca.snapshots.persist import record_analysis, record_calls
from cca.storage import ObjectMissingError, ObjectStore, ObjectTooLargeError

log = structlog.get_logger("cca.snapshots")

_TERMINAL = ("completed", "insufficient_data", "failed")

LOAD_MESSAGES = {
    "file_too_large": "The file is larger than the 25 MB limit.",
    "integrity_mismatch": "The stored file does not match what was uploaded, so it was not analyzed. Please upload it again.",
    "raw_file_deleted": "The uploaded file has already been deleted under the retention policy. Please upload it again.",
}


class IntegrityError(PermanentJobError):
    """The stored object does not match the hash recorded at upload."""


Clock = Callable[[], date]

ABSTAIN_ISSUE = {
    "code": "no_comparison",
    "severity": "error",
    "stage": "analyze",
    "message": "At least two consecutive complete months are needed to compare periods. "
    "Export a longer range (for example, the last three full months) and upload it again.",
}


def utc_today() -> date:
    return datetime.now(UTC).date()


def _no_model(consent_basis: str | None, attempt: int) -> DecisionModelProvider:
    """Default for tests and tools: classification disabled, consent still respected."""
    if consent_basis == CONSENT_PENDING:
        return UnavailableProvider(UnavailableReason.AWAITING_UNLOCK)
    if consent_basis != CONSENT_GRANTED:
        return UnavailableProvider(UnavailableReason.NO_CONSENT)
    return UnavailableProvider(UnavailableReason.DISABLED)


def make_handler(
    store: ObjectStore,
    max_bytes: int,
    today: Clock = utc_today,
    providers: ProviderFactory | None = None,
    explainer: ExplanationProvider | None = None,
    low_confidence: float = 0.5,
    concurrency: int = 4,
    noul_margin: float = 0.3,
) -> Callable[[Connection, Job], None]:
    provider_for = providers or _no_model
    explain = explainer or TemplateExplanationProvider()

    def handle(conn: Connection, job: Job) -> None:
        process_snapshot(conn, job, store, max_bytes, today, provider_for, explain, low_confidence, concurrency,
                         noul_margin)

    return handle


def _load_run(conn: Connection, run_id: UUID) -> dict[str, Any]:
    row = conn.execute(
        "SELECT r.id, r.status, r.source_file_id, r.consent_basis, r.unlocked_at, "
        "f.storage_key, f.sha256, f.size_bytes, f.raw_deleted_at "
        "FROM snapshot_run r JOIN source_file f "
        "  ON f.tenant_id = r.tenant_id AND f.id = r.source_file_id "
        "WHERE r.id = %s",
        (run_id,),
    ).fetchone()
    if row is None:
        raise PermanentJobError("snapshot run not found for this tenant")
    return dict(row)


def _set_status(conn: Connection, run_id: UUID, status: str, warnings: list[dict[str, Any]] | None = None) -> None:
    conn.execute(
        "UPDATE snapshot_run SET status = %s, warnings = warnings || %s, "
        "completed_at = CASE WHEN %s = ANY(%s) THEN now() ELSE completed_at END "
        "WHERE id = %s",
        (status, Jsonb(warnings or []), status, list(_TERMINAL), run_id),
    )


def _fail(conn: Connection, job: Job, run: dict[str, Any], issue: dict[str, Any]) -> None:
    with tenant_transaction(conn, job.tenant_id):
        _set_status(conn, run["id"], "failed", [issue])
        conn.execute("UPDATE source_file SET status = 'failed' WHERE id = %s", (run["source_file_id"],))


def _load_issue(code: str) -> dict[str, Any]:
    return {"code": code, "severity": "error", "stage": "load", "message": LOAD_MESSAGES[code]}


def process_snapshot(
    conn: Connection,
    job: Job,
    store: ObjectStore,
    max_bytes: int,
    today: Clock = utc_today,
    provider_for: ProviderFactory | None = None,
    explainer: ExplanationProvider | None = None,
    low_confidence: float = 0.5,
    concurrency: int = 4,
    noul_margin: float = 0.3,
) -> None:
    run_id = UUID(str(job.payload["snapshotRunId"]))
    full_phase = str(job.payload.get("phase", "teaser")) == "full"
    with tenant_transaction(conn, job.tenant_id):
        run = _load_run(conn, run_id)
        # A finished run is only re-processed to add classification after the report was unlocked.
        if run["status"] in _TERMINAL and not (full_phase and run["unlocked_at"] is not None):
            log.info("snapshot.already_finished", run_id=str(run_id), status=run["status"])
            return

    # ---- load
    if run["raw_deleted_at"] is not None:
        _fail(conn, job, run, _load_issue("raw_file_deleted"))
        return
    try:
        data = store.read(run["storage_key"], max_bytes)
    except ObjectMissingError as exc:
        raise RetryableJobError("uploaded object not readable yet") from exc
    except ObjectTooLargeError as exc:
        _fail(conn, job, run, _load_issue("file_too_large"))
        raise PermanentJobError("uploaded object exceeds the size limit") from exc
    if hashlib.sha256(data).hexdigest() != run["sha256"]:
        _fail(conn, job, run, _load_issue("integrity_mismatch"))
        raise IntegrityError("stored object hash differs from upload hash")

    with tenant_transaction(conn, job.tenant_id):
        _set_status(conn, run_id, "parsing")

    # ---- parse
    try:
        result = parse_billing_export(data, today=today())
    except ParseError as exc:
        # A data problem, not a job failure: record why and finish. Retrying the same bytes cannot help.
        _fail(conn, job, run, exc.to_issue().to_json(stage="parse"))
        log.info("snapshot.parse_failed", run_id=str(run_id), code=exc.code)
        return
    finally:
        del data
    parse_warnings = [i.to_json() for i in result.issues]
    _record_parse(conn, job, run, result, parse_warnings)

    # ---- analyze + classify (only through the provider allowed by this run's consent)
    base = (provider_for or _no_model)(run["consent_basis"], job.attempts)
    provider: DecisionModelProvider = base
    if isinstance(base, UnavailableProvider) and run["consent_basis"] == CONSENT_GRANTED:
        # The prospect agreed and we still have no classifier: a deployment problem, not their
        # choice. The report stays honest either way, so this log is the only way to find out.
        log.warning("snapshot.classification_unavailable", run_id=str(run_id), reason=str(base.reason))
    if not isinstance(base, UnavailableProvider):
        with tenant_transaction(conn, job.tenant_id):
            _set_status(conn, run_id, "classifying")
            cache = load_cached_answers(conn, base.name, base.model)
        provider = CachingProvider(base, cache)
    explain = explainer or TemplateExplanationProvider()
    try:
        analysis = analyze(result, run["sha256"], provider, explain, low_confidence, concurrency, noul_margin)
    finally:
        close = getattr(base, "close", None)
        if callable(close):
            close()

    if analysis.retryable and not job.is_last_attempt:
        # Keep the audit trail and any successful answers (the cache reuses them next attempt),
        # then retry the job with backoff. On the last attempt these findings become
        # "classification unavailable, review required" instead of blocking the snapshot.
        with tenant_transaction(conn, job.tenant_id):
            record_calls(conn, job.tenant_id, run_id, analysis)
        raise RetryableJobError(f"{len(analysis.retryable)} classification call(s) hit a transient failure")

    warnings = parse_warnings + ([ABSTAIN_ISSUE] if analysis.abstained else [])
    with tenant_transaction(conn, job.tenant_id):
        ran = not isinstance(base, UnavailableProvider)
        record_analysis(conn, job.tenant_id, run_id, analysis, warnings, explain.name,
                        base.name if ran else None, base.model if ran else None)
    log.info(
        "snapshot.analyzed",
        run_id=str(run_id),
        phase="full" if full_phase else "teaser",
        findings=len(analysis.findings),
        readiness=analysis.readiness.score,
        model_status=str(analysis.model_status) if analysis.model_status else None,
        abstained=analysis.abstained,
    )


def _record_parse(
    conn: Connection, job: Job, run: dict[str, Any], result: ParseResult, warnings: list[dict[str, Any]]
) -> None:
    s = result.stats
    with tenant_transaction(conn, job.tenant_id):
        # warnings are replaced, not appended, so a retried job never duplicates them
        conn.execute(
            "UPDATE snapshot_run SET status = 'analyzing', rows_seen = %s, rows_accepted = %s, rows_rejected = %s, "
            "total_cost = %s, currency = %s, warnings = %s WHERE id = %s",
            (s.lines_seen, s.lines_accepted, s.lines_rejected, result.total_cost, result.currency,
             Jsonb(warnings), run["id"]),
        )
        conn.execute(
            "UPDATE source_file SET status = 'processed', dimension = %s, "
            "detected_period_start = %s, detected_period_end = %s WHERE id = %s",
            (result.primary_dimension, result.period_start, result.period_end, run["source_file_id"]),
        )
