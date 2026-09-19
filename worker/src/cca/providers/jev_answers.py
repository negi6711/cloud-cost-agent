"""Runtime validation of Jev answers. Anything outside the question set's allowed values is rejected.

Works on plain dicts (the JSON shape of each answer) so live responses and cached answers are
validated by exactly the same code.
"""

from __future__ import annotations

import math
from typing import Any

from cca.providers.base import ChoiceAnswer, Classification, ScoreAnswer
from cca.providers.jev_questions_v1 import (
    CATEGORY_CRITERIA,
    MISSING_CRITERIA,
    OWNER_CRITERIA,
    QUESTION_KEYS,
    RISK_LEVELS,
    URGENCY_LEVELS,
)
from cca.snapshots.types import Category, MissingEvidence, OwnerGroup


class MalformedAnswersError(ValueError):
    """The response does not match the question set. Never repaired, never guessed."""


def _prob(value: Any, where: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or math.isnan(value) or not 0 <= value <= 1:
        raise MalformedAnswersError(f"{where}: not a probability")
    return float(value)


def _answer(answers: dict[str, Any], key: str, kind: str) -> dict[str, Any]:
    a = answers.get(key)
    if not isinstance(a, dict) or a.get("type") != kind:
        raise MalformedAnswersError(f"{key}: missing or not a {kind} answer")
    return a


def _choice(answers: dict[str, Any], key: str, allowed: set[str]) -> ChoiceAnswer:
    a = _answer(answers, key, "choice")
    value = a.get("choice")
    if value not in allowed:
        raise MalformedAnswersError(f"{key}: choice outside the allowed set")
    probs = a.get("probabilities")
    if not isinstance(probs, dict) or not set(probs) <= allowed:
        raise MalformedAnswersError(f"{key}: probabilities over unknown options")
    return ChoiceAnswer(
        value=str(value),
        confidence=_prob(a.get("confidence"), f"{key}.confidence"),
        probabilities={str(k): _prob(v, f"{key}.probabilities") for k, v in sorted(probs.items())},
    )


def _score(answers: dict[str, Any], key: str, levels: tuple[str, ...]) -> ScoreAnswer:
    a = _answer(answers, key, "score")
    raw = a.get("score")
    if isinstance(raw, bool) or not isinstance(raw, int | float) or not 0 <= raw <= len(levels) - 1:
        raise MalformedAnswersError(f"{key}: score outside the level range")
    probs = a.get("probabilities")
    if not isinstance(probs, dict):
        raise MalformedAnswersError(f"{key}: missing probabilities")
    by_level: dict[str, float] = {}
    for k, v in probs.items():
        idx = int(k)
        if not 0 <= idx < len(levels):
            raise MalformedAnswersError(f"{key}: probability for an unknown level")
        by_level[levels[idx]] = _prob(v, f"{key}.probabilities")
    return ScoreAnswer(
        label=levels[min(len(levels) - 1, round(float(raw)))],
        score=float(raw),
        confidence=_prob(a.get("confidence"), f"{key}.confidence"),
        probabilities=by_level,
    )


def _noul(answers: dict[str, Any], key: str) -> float:
    return _prob(_answer(answers, key, "noul").get("noul"), f"{key}.noul")


def validate_answers(answers: dict[str, Any]) -> Classification:
    missing = [k for k in QUESTION_KEYS if k not in answers]
    if missing:
        raise MalformedAnswersError(f"missing answers: {', '.join(missing)}")
    category = _choice(answers, "decision_category", set(CATEGORY_CRITERIA))
    owner = _choice(answers, "owner_group", set(OWNER_CRITERIA))
    missing_evidence = _choice(answers, "primary_missing_evidence", set(MISSING_CRITERIA))
    return Classification(
        category=Category(category.value),
        category_answer=category,
        owner=OwnerGroup(owner.value),
        owner_answer=owner,
        urgency=_score(answers, "urgency", URGENCY_LEVELS),
        risk=_score(answers, "risk_without_evidence", RISK_LEVELS),
        primary_missing=MissingEvidence(missing_evidence.value),
        missing_answer=missing_evidence,
        evidence_sufficient=_noul(answers, "evidence_sufficient"),
        needs_human_review=_noul(answers, "needs_human_review"),
        change_material=_noul(answers, "change_material"),
    )
