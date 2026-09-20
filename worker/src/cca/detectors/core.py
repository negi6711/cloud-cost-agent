"""Deterministic detectors over the monthly view. No models; every number is reproducible."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from cca.detectors.thresholds import (
    HIGH_SEVERITY_MULTIPLE,
    MAX_FINDINGS,
    MAX_SECONDARY_DIMENSION_FINDINGS,
    Thresholds,
    thresholds_for,
)
from cca.normalization.monthly import Key, MonthlyView
from cca.snapshots.types import Candidate, Category, FindingKind, MissingEvidence, Severity

HISTORY_MONTHS = 6
MAX_REFS = 20
_CENT = Decimal("0.01")
_PCT = Decimal("0.0001")

_MISSING: dict[FindingKind, tuple[MissingEvidence, ...]] = {
    FindingKind.MATERIAL_INCREASE: (
        MissingEvidence.UTILIZATION_METRICS,
        MissingEvidence.OWNER_CONFIRMATION,
        MissingEvidence.CHANGE_CONTEXT,
    ),
    FindingKind.NEW_SERVICE: (
        MissingEvidence.OWNER_CONFIRMATION,
        MissingEvidence.ENVIRONMENT_CLASSIFICATION,
        MissingEvidence.CHANGE_CONTEXT,
    ),
    FindingKind.UNALLOCATED: (MissingEvidence.ALLOCATION_TAGS, MissingEvidence.OWNER_CONFIRMATION),
}


@dataclass(frozen=True)
class ChangeRow:
    dimension: str
    label: str
    baseline: Decimal
    current: Decimal
    delta: Decimal
    delta_pct: Decimal | None


@dataclass
class Detection:
    thresholds: Thresholds
    comparison: tuple[date, date] | None
    candidates: list[Candidate]
    top_items: list[tuple[str, Decimal, Decimal]]  # (label, cost over covered period, share)
    largest_changes: dict[str, list[ChangeRow]]
    unallocated_share: Decimal | None
    unallocated_amount: Decimal | None
    notes: list[str] = field(default_factory=list)


def evidence_id(file_sha256: str, kind: FindingKind, key: Key, month: date) -> str:
    dimension, label = key
    label_hash = hashlib.sha256(label.encode("utf-8")).hexdigest()[:8]
    return f"ev_{file_sha256[:12]}_{kind.value}_{dimension}_{label_hash}_{month:%Y%m}"


def _pct(delta: Decimal, baseline: Decimal | None) -> Decimal | None:
    if baseline is None or baseline <= 0:
        return None
    return (delta / baseline).quantize(_PCT)


def _share(part: Decimal, whole: Decimal) -> Decimal:
    return (part / whole).quantize(_PCT) if whole > 0 else Decimal(0)


def _history(view: MonthlyView, key: Key, current: date) -> tuple[tuple[date, Decimal], ...]:
    months = [m for m in view.months if m <= current][-HISTORY_MONTHS:]
    return tuple((m, view.cost(key, m)) for m in months)


def _refs(view: MonthlyView, key: Key, months: list[date]) -> tuple[str, ...]:
    refs: list[str] = []
    for m in months:
        refs.extend(view.refs.get(key, {}).get(m, []))
    return tuple(refs[:MAX_REFS])


def _severity(delta: Decimal, t: Thresholds) -> Severity:
    if delta >= t.material_absolute * HIGH_SEVERITY_MULTIPLE:
        return Severity.HIGH
    if delta >= t.material_absolute:
        return Severity.MEDIUM
    return Severity.LOW


def detect(view: MonthlyView, file_sha256: str) -> Detection:
    comparison = view.comparison()
    current_month = comparison[1] if comparison else (view.complete_months or view.months)[-1]
    current_total = view.totals.get(current_month, Decimal(0))
    t = thresholds_for(view.covered_monthly_spend(), current_total)

    top = _top_items(view)
    largest: dict[str, list[ChangeRow]] = {}
    candidates: list[Candidate] = []

    if comparison:
        baseline_month, current_month = comparison
        for dimension in view.dimensions:
            rows = _changes(view, dimension, baseline_month, current_month)
            largest[dimension] = [r for r in rows if r.delta > 0][:5]
            # A breakdown with a single value (one account, one region) only repeats the whole-bill
            # change; it cannot point anywhere, so it yields no findings of its own.
            if dimension != view.primary_dimension and len(view.keys(dimension)) < 2:
                continue
            dim_candidates = [
                c
                for r in rows
                if (c := _increase_candidate(view, r, baseline_month, current_month, current_total, t, file_sha256))
            ]
            if dimension != view.primary_dimension:
                dim_candidates = dim_candidates[:MAX_SECONDARY_DIMENSION_FINDINGS]
            candidates.extend(dim_candidates)

    unallocated_amount, unallocated_share = None, None
    if view.unallocated:
        unallocated_amount = view.unallocated_totals.get(current_month, Decimal(0))
        unallocated_share = _share(unallocated_amount, current_total)
        if unallocated_share >= t.unallocated_share:
            candidates.append(_unallocated_candidate(view, current_month, comparison, unallocated_amount,
                                                     unallocated_share, t, file_sha256))

    candidates.sort(key=lambda c: _rank_key(c, view.primary_dimension))
    candidates = _drop_restatements(view, candidates, comparison)
    notes = [] if comparison else ["no_comparison"]
    return Detection(t, comparison, candidates[:MAX_FINDINGS], top, largest, unallocated_share, unallocated_amount, notes)


# Which heading describes a movement best when several describe it equally well. The group-by the
# export was built around comes first; an ownership tag names a team, which beats an account number.
_DIMENSION_PREFERENCE = ("tag", "service", "account", "region", "usage_type")


def _dimension_preference(dimension: str, primary: str) -> int:
    if dimension == primary:
        return 0
    if dimension in _DIMENSION_PREFERENCE:
        return 1 + _DIMENSION_PREFERENCE.index(dimension)
    return 1 + len(_DIMENSION_PREFERENCE)


def _rank_key(c: Candidate, primary: str) -> tuple[int, Decimal, int, str]:
    # Material changes first, then by size of the change (or amount, for unallocated spend).
    return (0 if c.material_absolute else 1, -c.delta, _dimension_preference(c.dimension, primary), c.evidence_id)


def _row_set(view: MonthlyView, key: Key, months: list[date]) -> frozenset[str]:
    """Every source row behind one key over the compared months (untruncated, unlike source_refs)."""
    refs: set[str] = set()
    for m in months:
        refs.update(view.refs.get(key, {}).get(m, []))
    return frozenset(refs)


def _drop_restatements(view: MonthlyView, candidates: list[Candidate], comparison: tuple[date, date] | None) -> list[Candidate]:
    """One movement can be described by several dimensions at once: "us-west-2 up $125,103.92" and
    "999999999999 up $125,103.92" are the same rows under different headings. Keep the best-ranked
    description and drop the exact restatements. Overlapping-but-different sets are left alone: a
    service inside a team's spend is a narrower fact, not a repetition."""
    if comparison is None:
        return candidates
    months = [comparison[0], comparison[1]]
    kept: list[Candidate] = []
    seen: list[frozenset[str]] = []
    for c in candidates:
        rows = _row_set(view, (c.dimension, c.label), months)
        if rows and rows in seen:
            continue
        kept.append(c)
        seen.append(rows)
    return kept


def _top_items(view: MonthlyView) -> list[tuple[str, Decimal, Decimal]]:
    months = view.complete_months or view.months
    grand = sum((view.totals[m] for m in months), Decimal(0))
    items = [
        (label, sum((view.cost((dim, label), m) for m in months), Decimal(0)))
        for dim, label in view.keys(view.primary_dimension)
    ]
    items.sort(key=lambda x: (-x[1], x[0]))
    return [(label, cost, _share(cost, grand)) for label, cost in items[:5]]


def _changes(view: MonthlyView, dimension: str, baseline: date, current: date) -> list[ChangeRow]:
    rows = []
    for key in view.keys(dimension):
        b, c = view.cost(key, baseline), view.cost(key, current)
        rows.append(ChangeRow(dimension, key[1], b, c, c - b, _pct(c - b, b)))
    rows.sort(key=lambda r: (-r.delta, r.label))
    return rows


def _increase_candidate(
    view: MonthlyView,
    row: ChangeRow,
    baseline_month: date,
    current_month: date,
    current_total: Decimal,
    t: Thresholds,
    file_sha256: str,
) -> Candidate | None:
    key = (row.dimension, row.label)
    # Unallocated catch-alls ("No tag key: team") are reported once, by the unallocated finding.
    if row.delta <= 0 or key in view.unallocated:
        return None
    had_history = any(view.cost(key, m) != 0 for m in view.months if m < current_month)
    is_new = row.dimension == "service" and not had_history
    material_absolute = row.delta >= t.material_absolute
    material_relative = row.delta_pct is not None and row.delta_pct >= t.material_relative and row.delta >= t.relative_min_delta

    if is_new:
        if row.current < t.new_service_min and not material_absolute:
            return None
        kind = FindingKind.NEW_SERVICE
        default = Category.REQUEST_EVIDENCE
    else:
        if not (material_absolute or material_relative):
            return None
        kind = FindingKind.MATERIAL_INCREASE
        share = _share(row.current, current_total)
        if material_absolute and row.delta >= t.material_absolute * HIGH_SEVERITY_MULTIPLE and share >= Decimal("0.10"):
            default = Category.ESCALATE
        elif material_absolute:
            default = Category.INVESTIGATE
        else:
            default = Category.MONITOR

    return Candidate(
        evidence_id=evidence_id(file_sha256, kind, key, current_month),
        kind=kind,
        dimension=row.dimension,
        label=row.label,
        current_month=current_month,
        baseline_month=baseline_month,
        current=row.current,
        baseline=row.baseline,
        delta=row.delta,
        delta_pct=row.delta_pct,
        share_of_current=_share(row.current, current_total),
        material_absolute=material_absolute,
        material_relative=material_relative,
        severity=_severity(row.delta, t),
        default_category=default,
        missing_evidence=_MISSING[kind],
        history=_history(view, key, current_month),
        source_refs=_refs(view, key, [baseline_month, current_month]),
    )


def _unallocated_candidate(
    view: MonthlyView,
    month: date,
    comparison: tuple[date, date] | None,
    amount: Decimal,
    share: Decimal,
    t: Thresholds,
    file_sha256: str,
) -> Candidate:
    keys = sorted(view.unallocated)
    key = (keys[0][0], "unallocated") if len({k[0] for k in keys}) == 1 else ("mixed", "unallocated")
    baseline_month = comparison[0] if comparison else None
    baseline = view.unallocated_totals.get(baseline_month, Decimal(0)) if baseline_month else None
    delta = amount - baseline if baseline is not None else Decimal(0)
    refs: list[str] = []
    for k in keys:
        refs.extend(view.refs.get(k, {}).get(month, []))
    return Candidate(
        evidence_id=evidence_id(file_sha256, FindingKind.UNALLOCATED, key, month),
        kind=FindingKind.UNALLOCATED,
        dimension=key[0],
        label=", ".join(k[1] for k in keys)[:200],
        current_month=month,
        baseline_month=baseline_month,
        current=amount,
        baseline=baseline,
        delta=delta,
        delta_pct=_pct(delta, baseline),
        share_of_current=share,
        material_absolute=amount >= t.material_absolute,
        material_relative=False,
        severity=_severity(amount, t),
        default_category=Category.REQUEST_EVIDENCE,
        missing_evidence=_MISSING[FindingKind.UNALLOCATED],
        history=tuple((m, view.unallocated_totals.get(m, Decimal(0))) for m in view.months if m <= month)[-HISTORY_MONTHS:],
        source_refs=tuple(refs[:MAX_REFS]),
    )
