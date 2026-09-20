"""Deterministic policy gate: the last word on every finding's category and review state.

A model classification is a suggestion. The gate keeps it (as jev_category) but decides the
final category from rules that the model cannot change:

1. The category is always one of the four live decisions (enforced by the enum and a DB CHECK).
2. No classification -> the rule-based default, human review required.
3. Low confidence, a model-requested review, or disagreement with deterministic materiality
   -> human review required. Pick-one and score answers are judged by the model's own confidence;
   yes/no answers have no confidence, so they are judged by their distance from a coin toss
   (|2p-1|) against a separate, looser threshold.
4. Data readiness below the threshold -> REQUEST_EVIDENCE.
5. New or unallocated spend is never "just monitor": it has no confirmed owner -> REQUEST_EVIDENCE.
6. A high-severity material change is never "just monitor" -> INVESTIGATE.
"""

from __future__ import annotations

from dataclasses import dataclass

from cca.detectors.thresholds import READINESS_REQUEST_EVIDENCE_BELOW
from cca.providers.base import ClassificationOutcome, ModelStatus
from cca.snapshots.types import Candidate, Category, FindingKind, Severity


class PolicyStatus:
    PASSED = "PASSED"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    POLICY_BLOCKED = "POLICY_BLOCKED"


@dataclass(frozen=True)
class Decision:
    final_category: Category
    model_status: ModelStatus
    policy_status: str
    reasons: tuple[str, ...]
    review_required: bool


def margin(p: float) -> float:
    """A yes/no probability's distance from a coin toss, on the same 0-1 scale as confidence."""
    return abs(2 * p - 1)


def decide(
    candidate: Candidate,
    outcome: ClassificationOutcome,
    readiness_score: int,
    low_confidence: float,
    noul_margin: float = 0.3,
) -> Decision:
    reasons: list[str] = []
    review = False
    c = outcome.classification

    if c is None:
        category = candidate.default_category
        model_status = ModelStatus.UNAVAILABLE_REVIEW_REQUIRED
        reasons.append(f"classification_unavailable:{outcome.unavailable_reason or 'unknown'}")
        review = True
    else:
        category = c.category
        model_status = ModelStatus.SUCCEEDED
        low = []
        if c.category_answer.confidence < low_confidence:
            low.append("category")
        if c.owner_answer.confidence < low_confidence:
            low.append("owner")
        if margin(c.change_material) < noul_margin:
            low.append("materiality")
        if low:
            model_status = ModelStatus.LOW_CONFIDENCE
            reasons.extend(f"low_confidence:{name}" for name in low)
            review = True
        if c.needs_human_review >= 0.5:
            reasons.append("model_requested_review")
            review = True
        if (c.change_material >= 0.5) != candidate.material:
            reasons.append("materiality_conflict")
            review = True

    blocked = False
    if readiness_score < READINESS_REQUEST_EVIDENCE_BELOW and category is not Category.REQUEST_EVIDENCE:
        category, blocked = Category.REQUEST_EVIDENCE, True
        reasons.append("readiness_below_threshold")
    if candidate.kind in (FindingKind.NEW_SERVICE, FindingKind.UNALLOCATED) and category is Category.MONITOR:
        category, blocked = Category.REQUEST_EVIDENCE, True
        reasons.append("ownerless_spend_requires_evidence")
    if candidate.severity is Severity.HIGH and candidate.material_absolute and category is Category.MONITOR:
        category, blocked = Category.INVESTIGATE, True
        reasons.append("material_change_not_monitor_only")

    if blocked:
        review = True
        # Only a model's suggestion can be "blocked"; overriding our own default is just the rule.
        policy_status = PolicyStatus.POLICY_BLOCKED if c is not None else PolicyStatus.REVIEW_REQUIRED
    else:
        policy_status = PolicyStatus.REVIEW_REQUIRED if review else PolicyStatus.PASSED

    return Decision(category, model_status, policy_status, tuple(reasons), review)
