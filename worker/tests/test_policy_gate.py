from __future__ import annotations

from dataclasses import replace
from datetime import date
from decimal import Decimal

import pytest

from cca.policy.gate import PolicyStatus, decide, margin
from cca.providers.base import (
    ChoiceAnswer,
    Classification,
    ClassificationOutcome,
    ModelStatus,
    ScoreAnswer,
    UnavailableReason,
)
from cca.snapshots.types import (
    Candidate,
    Category,
    FindingKind,
    MissingEvidence,
    OwnerGroup,
    Severity,
)

JULY, JUNE = date(2026, 7, 1), date(2026, 6, 1)

CANDIDATE = Candidate(
    evidence_id="ev_x", kind=FindingKind.MATERIAL_INCREASE, dimension="service", label="EC2",
    current_month=JULY, baseline_month=JUNE, current=Decimal(2000), baseline=Decimal(1000), delta=Decimal(1000),
    delta_pct=Decimal("1.0"), share_of_current=Decimal("0.3"), material_absolute=True, material_relative=True,
    severity=Severity.MEDIUM, default_category=Category.INVESTIGATE,
    missing_evidence=(MissingEvidence.UTILIZATION_METRICS,), history=(), source_refs=(),
)


def answer(value: str, confidence: float = 0.95) -> ChoiceAnswer:
    return ChoiceAnswer(value, confidence, {value: confidence})


def classification(**overrides: object) -> Classification:
    base = Classification(
        category=Category.INVESTIGATE, category_answer=answer("INVESTIGATE"),
        owner=OwnerGroup.PLATFORM_INFRASTRUCTURE, owner_answer=answer("platform_infrastructure"),
        urgency=ScoreAnswer("medium", 1.1, 0.9, {}), risk=ScoreAnswer("low", 0.2, 0.9, {}),
        primary_missing=MissingEvidence.UTILIZATION_METRICS, missing_answer=answer("utilization_metrics"),
        evidence_sufficient=0.2, needs_human_review=0.1, change_material=0.95,
    )
    return replace(base, **overrides)  # type: ignore[arg-type]


def ok(c: Classification) -> ClassificationOutcome:
    return ClassificationOutcome(c)


def test_confident_consistent_answer_passes() -> None:
    d = decide(CANDIDATE, ok(classification()), 85, 0.5)
    assert (d.final_category, d.model_status, d.policy_status, d.review_required) == (
        Category.INVESTIGATE, ModelStatus.SUCCEEDED, PolicyStatus.PASSED, False)


def test_no_classification_uses_the_rule_default_and_requires_review() -> None:
    d = decide(CANDIDATE, ClassificationOutcome(None, UnavailableReason.NO_CONSENT), 85, 0.5)
    assert d.final_category is Category.INVESTIGATE
    assert d.model_status is ModelStatus.UNAVAILABLE_REVIEW_REQUIRED
    assert d.reasons == ("classification_unavailable:no_consent",) and d.review_required


def test_low_confidence_requires_review_but_keeps_the_answer() -> None:
    d = decide(CANDIDATE, ok(classification(category=Category.ESCALATE, category_answer=answer("ESCALATE", 0.4))), 85, 0.5)
    assert (d.final_category, d.model_status) == (Category.ESCALATE, ModelStatus.LOW_CONFIDENCE)
    assert "low_confidence:category" in d.reasons and d.review_required


def test_a_coin_toss_yes_no_answer_counts_as_low_confidence() -> None:
    assert margin(0.55) == pytest.approx(0.1)
    d = decide(CANDIDATE, ok(classification(change_material=0.55)), 85, 0.5)
    assert "low_confidence:materiality" in d.reasons


def test_a_clear_yes_no_answer_is_confident_enough() -> None:
    # Jev answered 0.73 on real data: clear enough, and judged against its own looser threshold.
    assert margin(0.73) == pytest.approx(0.46)
    d = decide(CANDIDATE, ok(classification(change_material=0.73)), 85, 0.5)
    assert not any(r.startswith("low_confidence") for r in d.reasons)


def test_materiality_disagreement_requires_review() -> None:
    d = decide(CANDIDATE, ok(classification(change_material=0.05)), 85, 0.5)
    assert "materiality_conflict" in d.reasons and d.review_required


def test_model_requested_review_is_honored() -> None:
    d = decide(CANDIDATE, ok(classification(needs_human_review=0.8)), 85, 0.5)
    assert "model_requested_review" in d.reasons and d.policy_status == PolicyStatus.REVIEW_REQUIRED


def test_low_readiness_forces_request_evidence_over_the_model() -> None:
    d = decide(CANDIDATE, ok(classification(category=Category.ESCALATE, category_answer=answer("ESCALATE"))), 40, 0.5)
    assert d.final_category is Category.REQUEST_EVIDENCE
    assert d.policy_status == PolicyStatus.POLICY_BLOCKED and "readiness_below_threshold" in d.reasons


def test_low_readiness_also_applies_without_a_model() -> None:
    d = decide(CANDIDATE, ClassificationOutcome(None, UnavailableReason.DISABLED), 40, 0.5)
    assert d.final_category is Category.REQUEST_EVIDENCE and d.policy_status == PolicyStatus.REVIEW_REQUIRED


@pytest.mark.parametrize("kind", [FindingKind.NEW_SERVICE, FindingKind.UNALLOCATED])
def test_ownerless_spend_is_never_monitor_only(kind: FindingKind) -> None:
    c = replace(CANDIDATE, kind=kind)
    d = decide(c, ok(classification(category=Category.MONITOR, category_answer=answer("MONITOR"))), 85, 0.5)
    assert d.final_category is Category.REQUEST_EVIDENCE and "ownerless_spend_requires_evidence" in d.reasons


def test_high_severity_material_change_is_never_monitor_only() -> None:
    c = replace(CANDIDATE, severity=Severity.HIGH)
    d = decide(c, ok(classification(category=Category.MONITOR, category_answer=answer("MONITOR"))), 85, 0.5)
    assert d.final_category is Category.INVESTIGATE and "material_change_not_monitor_only" in d.reasons
