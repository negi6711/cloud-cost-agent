"""The real JevProvider and TypeSafe SDK against an in-memory HTTP transport (no network)."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx2
import pytest

from cca.providers.base import UnavailableReason
from cca.providers.jev import JevProvider
from cca.providers.jev_answers import MalformedAnswersError, validate_answers
from cca.providers.jev_questions_v1 import QUESTION_KEYS
from cca.providers.mock import mock_answers
from cca.snapshots.types import Category, MissingEvidence, OwnerGroup

PACKET: dict[str, Any] = {
    "packet_version": "ep/1",
    "context": {"currency": "USD", "current_month_total": "9119.00"},
    "finding": {"evidence_id": "ev_test", "kind": "new_service", "label": "Amazon Elastic Container Service",
                "share_of_current_month": "0.2018", "current_cost": "1840.00"},
}
SHA = "a" * 64
MODEL = "jev-1.13.0"


def good_answers(**overrides: Any) -> dict[str, Any]:
    answers = {
        "decision_category": {"type": "choice", "choice": "REQUEST_EVIDENCE", "confidence": 0.82,
                              "probabilities": {"INVESTIGATE": 0.1, "REQUEST_EVIDENCE": 0.8, "MONITOR": 0.05,
                                                "ESCALATE": 0.05}},
        "owner_group": {"type": "choice", "choice": "platform_infrastructure", "confidence": 0.7,
                        "probabilities": {"platform_infrastructure": 0.75, "unknown": 0.25}},
        "urgency": {"type": "score", "score": 1.4, "confidence": 0.6, "legend": {"0": "low", "1": "medium",
                    "2": "high", "3": "critical"}, "probabilities": {"0": 0.1, "1": 0.5, "2": 0.3, "3": 0.1}},
        "risk_without_evidence": {"type": "score", "score": 1.8, "confidence": 0.7,
                                  "legend": {"0": "low", "1": "medium", "2": "high"},
                                  "probabilities": {"0": 0.05, "1": 0.2, "2": 0.75}},
        "primary_missing_evidence": {"type": "choice", "choice": "owner_confirmation", "confidence": 0.66,
                                     "probabilities": {"owner_confirmation": 0.7, "utilization_metrics": 0.3}},
        "evidence_sufficient": {"type": "noul", "noul": 0.15},
        "needs_human_review": {"type": "noul", "noul": 0.35},
        "change_material": {"type": "noul", "noul": 0.93},
    }
    answers.update(overrides)
    return answers


def body(answers: dict[str, Any] | None = None, model: str = MODEL) -> dict[str, Any]:
    return {"model": model, "answers": answers or good_answers(), "usage": {"input_tokens": 1234, "output_tokens": 40}}


def provider(handler: Callable[[httpx2.Request], httpx2.Response], max_retries: int = 0) -> JevProvider:
    return JevProvider("test-key", MODEL, max_retries=max_retries, transport=httpx2.MockTransport(handler),
                       timeout_s=5)


def respond(status: int, payload: Any = None, headers: dict[str, str] | None = None):  # type: ignore[no-untyped-def]
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(status, json=payload if payload is not None else {"error": "x"}, headers=headers or {})

    return handler


# ---------------------------------------------------------------- success ---


def test_success_is_validated_and_fully_recorded() -> None:
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(200, json=body(), headers={"x-typesafe-request-id": "req_123"})

    outcome = provider(handler).classify(PACKET, SHA)
    c = outcome.classification
    assert c is not None and not outcome.retryable
    assert (c.category, c.owner, c.primary_missing) == (Category.REQUEST_EVIDENCE, OwnerGroup.PLATFORM_INFRASTRUCTURE,
                                                        MissingEvidence.OWNER_CONFIRMATION)
    assert (c.category_answer.confidence, c.urgency.label, c.risk.label) == (0.82, "medium", "high")
    assert c.change_material == 0.93

    [record] = outcome.calls
    assert (record.provider, record.model_requested, record.model_reported, record.request_id) == (
        "typesafe", MODEL, MODEL, "req_123")
    assert (record.status, record.input_tokens, record.question_set_version, record.packet_sha256) == (
        "succeeded", 1234, "jev-qs/1", SHA)
    assert record.answers is not None and set(record.answers) == set(QUESTION_KEYS)

    # What goes over the wire: the packet as state, the pinned model, our 8 questions, a bearer key.
    [request] = seen
    assert request.url.path == "/v1/systemone"
    assert request.headers["authorization"] == "Bearer test-key"
    sent = json.loads(request.content)
    assert sent["state"] == PACKET and sent["model"] == MODEL
    assert set(sent["questions"]) == set(QUESTION_KEYS)
    assert set(sent["questions"]["decision_category"]["criteria"]) == {
        "INVESTIGATE", "REQUEST_EVIDENCE", "MONITOR", "ESCALATE"}
    assert not {"RESIZE", "DELETE", "STOP", "BUY_COMMITMENT"} & set(sent["questions"]["decision_category"]["criteria"])


def test_missing_request_id_is_recorded_as_null() -> None:
    outcome = provider(respond(200, body())).classify(PACKET, SHA)
    assert outcome.classification is not None and outcome.calls[0].request_id is None


def test_a_different_reported_model_is_kept_visible() -> None:
    outcome = provider(respond(200, body(model="jev-1.14.0"))).classify(PACKET, SHA)
    assert outcome.classification is not None
    assert (outcome.calls[0].model_requested, outcome.calls[0].model_reported) == (MODEL, "jev-1.14.0")


def test_the_sdk_retries_rate_limits_before_giving_up() -> None:
    calls = {"n": 0}

    def handler(request: httpx2.Request) -> httpx2.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx2.Response(429, json={"error": "slow down"}, headers={"retry-after-ms": "10"})
        return httpx2.Response(200, json=body())

    outcome = provider(handler, max_retries=1).classify(PACKET, SHA)
    assert outcome.classification is not None and calls["n"] == 2


# --------------------------------------------------------------- failures ---


@pytest.mark.parametrize("status", [429, 500, 503, 529])
def test_transient_failures_are_retryable_and_never_invent_an_answer(status: int) -> None:
    outcome = provider(respond(status, headers={"x-typesafe-request-id": "req_err"})).classify(PACKET, SHA)
    assert outcome.classification is None
    assert (outcome.unavailable_reason, outcome.retryable) == (UnavailableReason.EXHAUSTED, True)
    [record] = outcome.calls
    assert (record.status, record.request_id, record.answers) == ("failed", "req_err", None)


def test_timeouts_are_retryable() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ReadTimeout("timed out", request=request)

    outcome = provider(handler).classify(PACKET, SHA)
    assert (outcome.unavailable_reason, outcome.retryable) == (UnavailableReason.EXHAUSTED, True)


@pytest.mark.parametrize(("status", "reason"), [(401, UnavailableReason.AUTH), (422, UnavailableReason.REJECTED),
                                                (400, UnavailableReason.REJECTED)])
def test_auth_and_request_errors_are_not_retried(status: int, reason: UnavailableReason) -> None:
    outcome = provider(respond(status)).classify(PACKET, SHA)
    assert (outcome.classification, outcome.unavailable_reason, outcome.retryable) == (None, reason, False)


@pytest.mark.parametrize(
    "answers",
    [
        good_answers(decision_category={"type": "choice", "choice": "DELETE", "confidence": 0.99,
                                        "probabilities": {"DELETE": 0.99}}),
        good_answers(owner_group={"type": "choice", "choice": "marketing", "confidence": 0.9,
                                  "probabilities": {"marketing": 0.9}}),
        good_answers(change_material={"type": "noul", "noul": 1.7}),
        good_answers(urgency={"type": "score", "score": 7, "confidence": 0.9, "legend": {}, "probabilities": {"7": 1}}),
        {k: v for k, v in good_answers().items() if k != "needs_human_review"},
    ],
    ids=["prohibited_category", "unknown_owner", "bad_probability", "score_out_of_range", "missing_question"],
)
def test_off_schema_answers_are_malformed_never_repaired(answers: dict[str, Any]) -> None:
    outcome = provider(respond(200, body(answers))).classify(PACKET, SHA)
    assert outcome.classification is None
    assert (outcome.unavailable_reason, outcome.retryable) == (UnavailableReason.MALFORMED, False)
    assert outcome.calls[0].status in ("malformed", "failed")


def test_validation_rejects_every_malformed_shape_directly() -> None:
    with pytest.raises(MalformedAnswersError):
        validate_answers(good_answers(decision_category={"type": "score", "score": 1}))
    with pytest.raises(MalformedAnswersError):
        validate_answers(good_answers(evidence_sufficient={"type": "noul", "noul": True}))


def test_mock_answers_satisfy_the_same_validation() -> None:
    c = validate_answers(mock_answers(PACKET))
    assert c.category is Category.REQUEST_EVIDENCE and c.owner is OwnerGroup.PLATFORM_INFRASTRUCTURE
