"""Writes an Analysis in one transaction: findings, evidence packets, model calls, run summary."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from cca.db import Connection
from cca.providers.base import CallRecord
from cca.snapshots.analyze import Analysis, AnalyzedFinding
from cca.snapshots.packet import PACKET_VERSION
from cca.snapshots.types import MISSING_EVIDENCE_LABELS, OWNER_LABELS

_FINDING_COLUMNS = (
    "tenant_id, snapshot_run_id, evidence_id, rank, kind, category, severity, title, explanation, "
    "observed_value, baseline_value, delta_value, owner, evidence, missing_evidence, "
    "rule_category, jev_category, jev_owner, jev_urgency, jev_risk, jev_confidence, jev_probabilities, "
    "model_evidence_ids, model_status, final_category, policy_status, policy_reasons, review_required, "
    "explanation_source, next_action"
)


def _finding_values(tenant_id: UUID, run_id: UUID, f: AnalyzedFinding) -> tuple[Any, ...]:
    c, d, card = f.candidate, f.decision, f.card
    cls = f.outcome.classification
    return (
        tenant_id,
        run_id,
        c.evidence_id,
        f.rank,
        c.kind.value,
        d.final_category.value,
        c.severity.value,
        card.title,
        card.what_changed,
        c.current,
        c.baseline,
        c.delta,
        OWNER_LABELS[cls.owner] if cls else None,
        Jsonb([{"text": s.text, "refs": list(s.refs)} for s in card.what_we_know]),
        Jsonb([{"code": m.value, "label": MISSING_EVIDENCE_LABELS[m]} for m in card.missing]),
        c.default_category.value,
        cls.category.value if cls else None,
        cls.owner.value if cls else None,
        cls.urgency.label if cls else None,
        cls.risk.label if cls else None,
        cls.category_answer.confidence if cls else None,
        Jsonb({"category": cls.category_answer.probabilities, "owner": cls.owner_answer.probabilities,
               "urgency": cls.urgency.probabilities, "risk": cls.risk.probabilities,
               "missing_evidence": cls.missing_answer.probabilities,
               "evidence_sufficient": cls.evidence_sufficient, "needs_human_review": cls.needs_human_review,
               "change_material": cls.change_material}) if cls else None,
        Jsonb([c.evidence_id]),
        d.model_status.value,
        d.final_category.value,
        d.policy_status,
        Jsonb(list(d.reasons)),
        d.review_required,
        card.source,
        card.next_action,
    )


def _call_values(tenant_id: UUID, run_id: UUID, evidence_id: str, call: CallRecord) -> tuple[Any, ...]:
    return (
        tenant_id, run_id, evidence_id, call.provider, call.model_requested, call.model_reported, call.request_id,
        call.question_set_version, call.packet_sha256, call.status, call.attempt, call.latency_ms,
        call.input_tokens, Jsonb(call.answers) if call.answers is not None else None, call.error_class,
    )


def record_calls(conn: Connection, tenant_id: UUID, run_id: UUID, analysis: Analysis) -> None:
    """Every provider call, successful or not, is kept (cache hits are not re-recorded)."""
    for f in analysis.findings:
        for call in f.outcome.calls:
            if call.status == "cached":
                continue
            conn.execute(
                "INSERT INTO model_call (tenant_id, snapshot_run_id, evidence_id, provider, model_requested, "
                "model_reported, request_id, question_set_version, packet_sha256, status, attempt, latency_ms, "
                "input_tokens, answers, error_class) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                _call_values(tenant_id, run_id, f.candidate.evidence_id, call),
            )


def record_analysis(
    conn: Connection,
    tenant_id: UUID,
    run_id: UUID,
    analysis: Analysis,
    warnings: list[dict[str, Any]],
    explanation_provider: str,
    model_provider: str | None = None,
    model_identifier: str | None = None,
) -> None:
    """Call inside a tenant transaction. Idempotent per (run, evidence_id): the deterministic teaser
    phase inserts, and the unlock phase updates the same rows with the classification."""
    record_calls(conn, tenant_id, run_id, analysis)
    placeholders = ", ".join(["%s"] * len(_FINDING_COLUMNS.split(", ")))
    for f in analysis.findings:
        updates = ", ".join(
            f"{c} = EXCLUDED.{c}"
            for c in _FINDING_COLUMNS.split(", ")
            if c not in ("tenant_id", "snapshot_run_id", "evidence_id")
        )
        conn.execute(
            f"INSERT INTO snapshot_finding ({_FINDING_COLUMNS}) VALUES ({placeholders}) "  # noqa: S608 - fixed columns
            f"ON CONFLICT (tenant_id, snapshot_run_id, evidence_id) DO UPDATE SET {updates}",
            _finding_values(tenant_id, run_id, f),
        )
        conn.execute(
            "INSERT INTO evidence_packet (tenant_id, snapshot_run_id, evidence_id, version, sha256, packet) "
            "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (tenant_id, snapshot_run_id, evidence_id) "
            "DO UPDATE SET version = EXCLUDED.version, sha256 = EXCLUDED.sha256, packet = EXCLUDED.packet",
            (tenant_id, run_id, f.candidate.evidence_id, PACKET_VERSION, f.packet_sha256, Jsonb(f.packet)),
        )

    status = "insufficient_data" if analysis.abstained else "completed"
    conn.execute(
        "UPDATE snapshot_run SET status = %s, warnings = %s, summary = %s, data_readiness_score = %s, "
        "evidence_packet_version = %s, evidence_packet_sha256 = %s, model_status = %s, "
        "model_provider = %s, model_identifier = %s, explanation_provider = %s, completed_at = now() WHERE id = %s",
        (
            status,
            Jsonb(warnings),
            Jsonb(analysis.summary),
            analysis.readiness.score,
            PACKET_VERSION if analysis.findings else None,
            analysis.packets_sha256,
            analysis.model_status.value if analysis.model_status else None,
            model_provider,
            model_identifier,
            explanation_provider,
            run_id,
        ),
    )
