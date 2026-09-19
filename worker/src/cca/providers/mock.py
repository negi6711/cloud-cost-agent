"""Deterministic stand-in for Jev, for local development and end-to-end tests only.

It is labelled "mock" everywhere it is recorded and shown ("Test classifier — not a real model"),
and settings refuse it in staging and production, so it can never silently replace Jev.
"""

from __future__ import annotations

from typing import Any

from cca.providers.base import CallRecord, ClassificationOutcome
from cca.providers.jev_answers import validate_answers
from cca.providers.jev_questions_v1 import VERSION

PROVIDER_NAME = "mock"
MODEL_NAME = "mock-classifier-1"

_OWNER_HINTS = (
    (("sagemaker", "bedrock", "gpu"), "ml_ai"),
    (("redshift", "athena", "glue", "emr", "kinesis"), "data"),
    (("guardduty", "waf", "kms", "security"), "security"),
    (("tax", "support", "marketplace"), "finance"),
    (("lambda", "api gateway", "sqs", "sns"), "application_engineering"),
    (("compute", "container", "rds", "relational", "storage", "cloudwatch", "vpc"), "platform_infrastructure"),
)


def _choice(value: str, confidence: float) -> dict[str, Any]:
    return {"type": "choice", "choice": value, "confidence": confidence, "probabilities": {value: confidence}}


def _score(level: int, confidence: float) -> dict[str, Any]:
    return {"type": "score", "score": float(level), "confidence": confidence, "legend": {},
            "probabilities": {str(level): confidence}}


def mock_answers(packet: dict[str, Any]) -> dict[str, Any]:
    finding = packet["finding"]
    kind, label = finding["kind"], str(finding["label"]).lower()
    category = {"new_service": "REQUEST_EVIDENCE", "unallocated_spend": "REQUEST_EVIDENCE"}.get(kind, "INVESTIGATE")
    owner = next((o for keys, o in _OWNER_HINTS if any(k in label for k in keys)), "unknown")
    missing = {"unallocated_spend": "allocation_tags", "new_service": "owner_confirmation"}.get(kind, "utilization_metrics")
    share = float(finding["share_of_current_month"])
    return {
        "decision_category": _choice(category, 0.9),
        "owner_group": _choice(owner, 0.8 if owner != "unknown" else 0.6),
        "urgency": _score(2 if share >= 0.1 else 1, 0.8),
        "risk_without_evidence": _score(1, 0.8),
        "primary_missing_evidence": _choice(missing, 0.85),
        "evidence_sufficient": {"type": "noul", "noul": 0.2},
        "needs_human_review": {"type": "noul", "noul": 0.3},
        "change_material": {"type": "noul", "noul": 0.9 if share >= 0.05 else 0.3},
    }


class MockJevProvider:
    name = PROVIDER_NAME
    model = MODEL_NAME

    def __init__(self, attempt: int = 1) -> None:
        self.attempt = attempt

    def classify(self, packet: dict[str, Any], packet_sha256: str) -> ClassificationOutcome:
        answers = mock_answers(packet)
        record = CallRecord(
            provider=self.name, model_requested=self.model, model_reported=self.model, request_id=None,
            question_set_version=VERSION, packet_sha256=packet_sha256, status="succeeded", attempt=self.attempt,
            latency_ms=0, input_tokens=None, answers=answers, error_class=None,
        )
        return ClassificationOutcome(validate_answers(answers), None, False, [record])
