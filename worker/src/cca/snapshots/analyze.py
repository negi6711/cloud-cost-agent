"""Analysis pipeline for one parsed export:

    monthly view -> detectors -> readiness -> evidence packets -> model classification
    -> policy gate -> explanations -> summary

Pure computation plus the provider call; persistence lives in cca.snapshots.process.
"""

from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from cca.detectors.core import MAX_MISSING_EVIDENCE, Detection, detect
from cca.normalization.monthly import MonthlyView, build_monthly_view
from cca.parsers.model import ParseResult
from cca.policy.gate import Decision, decide
from cca.providers.base import ClassificationOutcome, DecisionModelProvider, ModelStatus
from cca.snapshots.explain import Card, ExplanationInput, ExplanationProvider
from cca.snapshots.packet import PACKET_VERSION, Aliases, RunContext, build_packet, packet_sha256
from cca.snapshots.readiness import Readiness, readiness
from cca.snapshots.types import Candidate, MissingEvidence

_OWNERSHIP_DIMENSIONS = {"tag", "account", "cost_category"}


@dataclass(frozen=True)
class AnalyzedFinding:
    rank: int
    candidate: Candidate
    packet: dict[str, Any]
    packet_sha256: str
    outcome: ClassificationOutcome
    decision: Decision
    card: Card


@dataclass(frozen=True)
class Analysis:
    readiness: Readiness
    detection: Detection
    findings: list[AnalyzedFinding]
    summary: dict[str, Any]
    packets_sha256: str | None
    model_status: ModelStatus | None
    abstained: bool

    @property
    def retryable(self) -> list[AnalyzedFinding]:
        """Findings whose model call hit a transient failure (rate limit, overload, timeout)."""
        return [f for f in self.findings if f.outcome.retryable]


def _ctx(view: MonthlyView, result: ParseResult, detection: Detection, score: int) -> RunContext:
    baseline, current = detection.comparison or (None, (view.complete_months or view.months)[-1])
    assert result.period_start is not None and result.period_end is not None
    return RunContext(
        period_start=result.period_start,
        period_end=result.period_end,
        currency=result.currency,
        covered_total=result.total_cost,
        covered_monthly_average=detection.thresholds.covered_monthly_spend,
        baseline_month=baseline,
        current_month=current,
        baseline_total=view.totals.get(baseline) if baseline else None,
        current_total=view.totals.get(current, Decimal(0)),
        readiness_score=score,
        data_quality=tuple(sorted({i.code for i in result.issues})),
        dimensions_available=result.dimensions_available,
    )


def _run_model_status(findings: list[AnalyzedFinding]) -> ModelStatus | None:
    statuses = {f.decision.model_status for f in findings}
    if not statuses:
        return None
    for status in (ModelStatus.UNAVAILABLE_REVIEW_REQUIRED, ModelStatus.LOW_CONFIDENCE):
        if status in statuses:
            return status
    return ModelStatus.SUCCEEDED


def analyze(
    result: ParseResult,
    file_sha256: str,
    provider: DecisionModelProvider,
    explainer: ExplanationProvider,
    low_confidence: float,
    concurrency: int = 4,
    noul_margin: float = 0.3,
    packet_version: str = PACKET_VERSION,
) -> Analysis:
    view = build_monthly_view(result)
    detection = detect(view, file_sha256, result.records)
    ready = readiness(result, detection)
    ctx = _ctx(view, result, detection, ready.score)
    ownership_visible = bool(set(result.dimensions_available) & _OWNERSHIP_DIMENSIONS)
    total_change = (
        view.totals[detection.comparison[1]] - view.totals[detection.comparison[0]] if detection.comparison else None
    )

    labels_by_dimension: dict[str, list[str]] = {}
    for dimension, label in view.series:
        labels_by_dimension.setdefault(dimension, []).append(label)
    aliases = Aliases.for_labels(labels_by_dimension)

    # Where this movement sits among the month's others: a model cannot judge "material" without it.
    material_count = sum(1 for c in detection.candidates if c.material)
    packets = [
        build_packet(c, ctx, aliases, version=packet_version, peers={
            "rank": rank,
            "findings_this_month": len(detection.candidates),
            "other_material_movements": material_count - (1 if c.material else 0),
            "share_of_bill_increase": (
                None if not total_change or total_change <= 0
                else str(min(Decimal(1), c.delta / total_change).quantize(Decimal("0.0001")))
            ),
        })
        for rank, c in enumerate(detection.candidates, start=1)
    ]
    shas = [packet_sha256(p) for p in packets]
    # Jev evaluates each finding independently; calls run concurrently, results keep rank order.
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        outcomes = list(pool.map(provider.classify, packets, shas))

    findings: list[AnalyzedFinding] = []
    for rank, (candidate, packet, sha, outcome) in enumerate(
        zip(detection.candidates, packets, shas, outcomes, strict=True), start=1
    ):
        decision = decide(candidate, outcome, ready.score, low_confidence, noul_margin)
        missing = _missing_order(candidate, outcome)
        card = explainer.explain(ExplanationInput(candidate, decision.final_category, result.currency, missing,
                                                  ownership_visible, total_change))
        findings.append(AnalyzedFinding(rank, candidate, packet, sha, outcome, decision, card))

    packets_sha = (
        hashlib.sha256("".join(f.packet_sha256 for f in findings).encode()).hexdigest() if findings else None
    )
    return Analysis(
        readiness=ready,
        detection=detection,
        findings=findings,
        summary=_summary(view, result, detection, ready),
        packets_sha256=packets_sha,
        model_status=_run_model_status(findings),
        abstained=detection.comparison is None,
    )


def _missing_order(candidate: Candidate, outcome: ClassificationOutcome) -> tuple[MissingEvidence, ...]:
    """The rule-based list, plus any gap the model names that we had not listed.

    The model's answer used to go first. Measured over the Day 7 corpus, it answered
    "change_context" for 28 of 29 increases, so putting it first ordered every card the same way and
    made the next action redundant: "ask what changed ... and collect the change behind it". A
    constant is not a ranking. The answer is still recorded on every finding, so a future model
    version that does discriminate will show up in the data — and when it names a gap our rules
    missed, that still earns a line here.
    """
    items = list(candidate.missing_evidence)
    c = outcome.classification
    if c is not None and c.primary_missing not in (MissingEvidence.NONE, *items):
        if len(items) >= MAX_MISSING_EVIDENCE and MissingEvidence.CHANGE_CONTEXT in items:
            items.remove(MissingEvidence.CHANGE_CONTEXT)  # the most generic one makes way
        items.append(c.primary_missing)
    return tuple(items[:MAX_MISSING_EVIDENCE])


def _money(d: Decimal | None) -> str | None:
    return None if d is None else str(d.quantize(Decimal("0.01")))


def _summary(view: MonthlyView, result: ParseResult, detection: Detection, ready: Readiness) -> dict[str, Any]:
    comparison = None
    whole_bill_rise: Decimal | None = None
    if detection.comparison:
        b, c = detection.comparison
        delta = view.totals[c] - view.totals[b]
        whole_bill_rise = delta
        comparison = {
            "baseline_month": f"{b:%Y-%m}",
            "current_month": f"{c:%Y-%m}",
            "baseline_total": _money(view.totals[b]),
            "current_total": _money(view.totals[c]),
            "delta": _money(delta),
            "delta_pct": str((delta / view.totals[b]).quantize(Decimal("0.0001"))) if view.totals[b] > 0 else None,
        }
    gaps = [{"code": "billing_only", "message": "Billing data only: utilization, ownership and environment are not visible."}]
    dims = set(result.dimensions_available)
    if not dims & {"account", "region"}:
        gaps.append({"code": "no_account_region",
                     "message": "No account or region breakdown in this export; changes are shown by "
                                f"{result.dimension_label.lower()} only."})
    if not dims & _OWNERSHIP_DIMENSIONS:
        gaps.append({"code": "no_ownership_dimension",
                     "message": "No team tag or account grouping, so owners cannot be inferred from billing data."})
    if detection.comparison is None:
        gaps.append({"code": "no_comparison",
                     "message": "At least two consecutive complete months are needed to compare periods."})

    # The teaser headline: how much month-over-month increase the material findings account for.
    # This is money that MOVED, not money anyone can recover; the copy must never call it savings.
    #
    # Only the primary dimension counts. Every row has exactly one service, so service increases add
    # up to at most the whole bill's increase; adding the account, region and tag views of the same
    # rows would count the same money three more times. The whole-bill increase is a hard ceiling.
    rise = sum(
        (c.delta for c in detection.candidates
         if c.material and c.delta > 0 and c.dimension == result.primary_dimension),
        Decimal(0),
    )
    investigation_impact = (
        min(rise, whole_bill_rise) if whole_bill_rise is not None and whole_bill_rise > 0 else rise
    )
    return {
        "version": 1,
        "investigation_impact": _money(investigation_impact),
        "period": {"start": result.period_start.isoformat() if result.period_start else None,
                   "end": result.period_end.isoformat() if result.period_end else None},
        "granularity": str(result.granularity),
        "currency": result.currency,
        "dimension": result.primary_dimension,
        "dimension_label": result.dimension_label,
        "dimensions_available": list(result.dimensions_available),
        "total": _money(result.total_cost),
        "months": [
            {"month": f"{m:%Y-%m}", "total": _money(view.totals[m]), "complete": view.complete[m]} for m in view.months
        ],
        "comparison": comparison,
        "top_items": [{"label": label, "cost": _money(cost), "share": str(share)}
                      for label, cost, share in detection.top_items],
        "largest_changes": {
            dim: [{"label": r.label, "baseline": _money(r.baseline), "current": _money(r.current),
                   "delta": _money(r.delta), "delta_pct": None if r.delta_pct is None else str(r.delta_pct)}
                  for r in rows]
            for dim, rows in detection.largest_changes.items()
        },
        "unallocated": None if detection.unallocated_amount is None else {
            "amount": _money(detection.unallocated_amount), "share": str(detection.unallocated_share)},
        "data_gaps": gaps,
        "readiness": ready.to_json(),
        "thresholds": detection.thresholds.to_json(),
    }
