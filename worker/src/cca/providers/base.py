"""Model-provider interfaces. Providers return typed, validated suggestions; the policy gate decides.

Only minimized evidence packets (cca.snapshots.packet) are ever passed to a provider.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol

from cca.snapshots.types import Category, MissingEvidence, OwnerGroup


class ModelStatus(StrEnum):
    PENDING = "JEV_PENDING"
    SUCCEEDED = "JEV_SUCCEEDED"
    LOW_CONFIDENCE = "JEV_LOW_CONFIDENCE"
    RETRYABLE_FAILURE = "JEV_RETRYABLE_FAILURE"
    UNAVAILABLE_REVIEW_REQUIRED = "JEV_UNAVAILABLE_REVIEW_REQUIRED"


class UnavailableReason(StrEnum):
    AWAITING_UNLOCK = "awaiting_unlock"  # deterministic teaser phase, before the email gate
    DISABLED = "disabled"  # JEV_ENABLED=false
    NO_CONSENT = "no_consent"  # the prospect declined external processing
    NOT_CONFIGURED = "not_configured"
    EXHAUSTED = "retries_exhausted"
    MALFORMED = "malformed_response"
    AUTH = "authentication_failed"
    REJECTED = "request_rejected"


@dataclass(frozen=True)
class ChoiceAnswer:
    value: str
    confidence: float
    probabilities: dict[str, float]


@dataclass(frozen=True)
class ScoreAnswer:
    label: str  # nearest level
    score: float
    confidence: float
    probabilities: dict[str, float]


@dataclass(frozen=True)
class Classification:
    """Validated typed answers for one finding. Values are restricted to our enums."""

    category: Category
    category_answer: ChoiceAnswer
    owner: OwnerGroup
    owner_answer: ChoiceAnswer
    urgency: ScoreAnswer
    risk: ScoreAnswer
    primary_missing: MissingEvidence
    missing_answer: ChoiceAnswer
    evidence_sufficient: float  # probability of "yes"
    needs_human_review: float
    change_material: float


@dataclass(frozen=True)
class CallRecord:
    """What is persisted per provider call (model_call), whatever the outcome."""

    provider: str
    model_requested: str
    model_reported: str | None
    request_id: str | None
    question_set_version: str
    packet_sha256: str
    status: str  # succeeded | failed | skipped | cached
    attempt: int
    latency_ms: int | None
    input_tokens: int | None
    answers: dict[str, Any] | None
    error_class: str | None


@dataclass(frozen=True)
class ClassificationOutcome:
    classification: Classification | None
    unavailable_reason: UnavailableReason | None = None
    retryable: bool = False
    calls: list[CallRecord] = field(default_factory=list)


class DecisionModelProvider(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def model(self) -> str: ...

    def classify(self, packet: dict[str, Any], packet_sha256: str) -> ClassificationOutcome: ...


@dataclass
class UnavailableProvider:
    """Used when classification must not or cannot run. Never invents an answer."""

    reason: UnavailableReason
    name: str = "typesafe"
    model: str = "none"

    def classify(self, packet: dict[str, Any], packet_sha256: str) -> ClassificationOutcome:
        return ClassificationOutcome(None, self.reason)
