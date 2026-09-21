"""Deterministic policy gate: the last word on every finding's category and review state.

**Our rules decide the category.** A model classification is a second opinion: it is recorded next
to the decision (`jev_category`), it can ask for a human, and it never publishes a category.

That is a change from the first design, in which a successful classification supplied the category
and the rules could only override it in narrow cases. Measured over 58 findings from ten exports
(ADR 0003), the model changed the published decision on 43 of them, used two of the four categories,
and had a median confidence of 0.43 — while the report told the reader "our rules made the final
call". The claim was false and the provenance was unreadable. Now it is true by construction.

The rules, in order:

1. The category is the deterministic default for this finding (`Candidate.default_category`),
   always one of the four live decisions (enforced by the enum and a DB CHECK).
2. Data readiness below the threshold -> REQUEST_EVIDENCE, whatever the default said: with data this
   thin, collecting evidence is the only honest next step.
3. Human review is required when: no classification ran; the model's confidence is low; the model
   asked for review; or the model disagrees with our deterministic materiality. Pick-one and score
   answers are judged by the model's own confidence; yes/no answers have no confidence, so they are
   judged by their distance from a coin toss (|2p-1|) against a separate, looser threshold.

Two rules were removed when the model stopped deciding: "ownerless spend is never monitor-only" and
"a high-severity material change is never monitor-only". Both existed to bound a model answer, and
neither can fire against our own defaults — new and unallocated spend already default to
REQUEST_EVIDENCE, and a MONITOR default means the change was not absolutely material, which is
exactly what the second rule required. If a model is ever given authority again (ADR 0004), they
come back with it.
"""

from __future__ import annotations

from dataclasses import dataclass

from cca.detectors.thresholds import READINESS_REQUEST_EVIDENCE_BELOW
from cca.providers.base import ClassificationOutcome, ModelStatus
from cca.snapshots.types import Candidate, Category


class PolicyStatus:
    PASSED = "PASSED"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    #: The model suggested a different category from the one our rules published.
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

    # The decision is ours, whether or not a model ran.
    category = candidate.default_category

    if c is None:
        model_status = ModelStatus.UNAVAILABLE_REVIEW_REQUIRED
        reasons.append(f"classification_unavailable:{outcome.unavailable_reason or 'unknown'}")
        review = True
    else:
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

    if readiness_score < READINESS_REQUEST_EVIDENCE_BELOW and category is not Category.REQUEST_EVIDENCE:
        # Our own rule adjusting our own default is not a "block", it is just the rule.
        category = Category.REQUEST_EVIDENCE
        reasons.append("readiness_below_threshold")
        review = True

    if c is not None and c.category is not category:
        # Recorded, not acted on. This is the number ADR 0003 watches per model version.
        policy_status = PolicyStatus.POLICY_BLOCKED
    elif review:
        policy_status = PolicyStatus.REVIEW_REQUIRED
    else:
        policy_status = PolicyStatus.PASSED

    return Decision(category, model_status, policy_status, tuple(reasons), review)
