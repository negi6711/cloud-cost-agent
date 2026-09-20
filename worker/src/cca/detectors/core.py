"""Deterministic detectors over the monthly view. No models; every number is reproducible."""

from __future__ import annotations

import hashlib
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from datetime import date
from decimal import Decimal

from cca.detectors.thresholds import (
    HIGH_SEVERITY_MULTIPLE,
    MAX_FINDINGS,
    Thresholds,
    thresholds_for,
)
from cca.normalization.monthly import Key, MonthlyView
from cca.parsers.model import CostRecord
from cca.snapshots.types import (
    Candidate,
    Category,
    Component,
    FindingKind,
    MissingEvidence,
    Severity,
)

HISTORY_MONTHS = 6
MAX_REFS = 20
# A component has to explain a real part of the movement to be worth a line in the card.
COMPONENT_MIN_SHARE = Decimal("0.15")
MAX_COMPONENTS = 3
# A tag that covers this much of a movement answers "who owns it" on its own.
OWNER_KNOWN_SHARE = Decimal("0.9")
MAX_MISSING_EVIDENCE = 3
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


def _ref_order(ref: str) -> tuple[int, int]:
    """"L12:C3" -> (12, 3). Source references are evidence a reader checks against their own file,
    so they are shown in file order rather than in whatever order the months were walked."""
    line, _, column = ref.lstrip("L").partition(":C")
    return (int(line) if line.isdigit() else 0, int(column) if column.isdigit() else 0)


def _refs(view: MonthlyView, key: Key, months: list[date]) -> tuple[str, ...]:
    refs: set[str] = set()
    for m in months:
        refs.update(view.refs.get(key, {}).get(m, []))
    return tuple(sorted(refs, key=_ref_order)[:MAX_REFS])


def _severity(delta: Decimal, t: Thresholds) -> Severity:
    if delta >= t.material_absolute * HIGH_SEVERITY_MULTIPLE:
        return Severity.HIGH
    if delta >= t.material_absolute:
        return Severity.MEDIUM
    return Severity.LOW


def detect(view: MonthlyView, file_sha256: str, records: Sequence[CostRecord] = ()) -> Detection:
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
            # Findings come from the grouping the export is built around. Every row has exactly one
            # value in it, so those movements partition the bill and none of them restates another.
            # The other groupings describe the same rows from a different angle: they become
            # composition inside a finding (below), not findings of their own.
            if dimension != view.primary_dimension:
                continue
            candidates.extend(
                c
                for r in rows
                if (c := _increase_candidate(view, r, baseline_month, current_month, current_total, t, file_sha256))
            )

    unallocated_amount, unallocated_share = None, None
    if view.unallocated:
        unallocated_amount = view.unallocated_totals.get(current_month, Decimal(0))
        unallocated_share = _share(unallocated_amount, current_total)
        if unallocated_share >= t.unallocated_share:
            candidates.append(_unallocated_candidate(view, current_month, comparison, unallocated_amount,
                                                     unallocated_share, t, file_sha256))

    candidates.sort(key=_rank_key)
    kept = candidates[:MAX_FINDINGS]
    if comparison and records:
        # A grouping with a single value across the whole export (one account, one region) cannot
        # narrow anything down: "100% of it is in the only account you have" is not a fact.
        informative = {d for d in view.dimensions if d != view.primary_dimension and len(view.keys(d)) > 1}
        kept = _with_components(kept, records, comparison, view.primary_dimension, informative,
                                set(view.dimensions))
    notes = [] if comparison else ["no_comparison"]
    return Detection(t, comparison, kept, top, largest, unallocated_share, unallocated_amount, notes)


def _with_components(
    candidates: list[Candidate],
    records: Sequence[CostRecord],
    comparison: tuple[date, date],
    primary: str,
    informative: set[str],
    available: set[str],
) -> list[Candidate]:
    """Describe each movement through the export's other groupings, from the same rows.

    One pass over the two compared months, bucketed by the primary label, so the cost does not grow
    with the number of findings. A component is kept only when it explains a real share of the
    movement; three at most, largest first, one per grouping so the same money is not listed twice.
    """
    baseline_month, current_month = comparison
    wanted = {c.label for c in candidates if c.dimension == primary}
    by_label: dict[str, list[CostRecord]] = {label: [] for label in wanted}
    for record in records:
        month = record.period_start.replace(day=1)
        if month not in (baseline_month, current_month):
            continue
        label = record.dimension(primary)
        if label in by_label:
            by_label[label].append(record)

    out: list[Candidate] = []
    for candidate in candidates:
        rows = by_label.get(candidate.label) if candidate.dimension == primary else None
        if not rows or candidate.delta <= 0:
            out.append(candidate)
            continue
        sums: dict[Key, dict[date, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
        for record in rows:
            month = record.period_start.replace(day=1)
            for dimension, label in record.dimensions:
                if dimension in informative:
                    sums[(dimension, label)][month] += record.cost
        best: dict[str, Component] = {}
        for (dimension, label), months in sums.items():
            delta = months.get(current_month, Decimal(0)) - months.get(baseline_month, Decimal(0))
            share = (delta / candidate.delta).quantize(_PCT)
            if delta <= 0 or share < COMPONENT_MIN_SHARE:
                continue
            if dimension not in best or delta > best[dimension].delta:
                best[dimension] = Component(dimension, label, delta, share)
        components = sorted(best.values(), key=lambda c: -c.delta)[:MAX_COMPONENTS]
        out.append(replace(
            candidate,
            components=tuple(components),
            missing_evidence=_missing_for(candidate.kind, tuple(components), available),
        ))
    return out


#: A grouping that names a team. An account number does not: it is where the spend sits, not who
#: decided to spend it.
_NAMES_AN_OWNER = ("tag", "cost_category")
#: Groupings fine enough to point at the capacity behind a movement.
_SHOWS_CAPACITY = ("usage_type", "instance_type")


def _missing_for(
    kind: FindingKind,
    components: tuple[Component, ...],
    available: set[str],
) -> tuple[MissingEvidence, ...]:
    """What this finding is actually short of, given what the export turned out to contain.

    The same three items on every card ("utilization, owner, change context") told a reader nothing
    about which finding needed what. An export with team tags does not need to be asked who owns
    something it already says; an export with no usage-type breakdown cannot be asked about
    utilization, because what is missing first is finer-grained billing.
    """
    if kind is FindingKind.UNALLOCATED:
        return (MissingEvidence.ALLOCATION_TAGS, MissingEvidence.OWNER_CONFIRMATION)

    missing: list[MissingEvidence] = []
    owner = next((c for c in components if c.dimension in _NAMES_AN_OWNER), None)
    if not any(d in available for d in _NAMES_AN_OWNER):
        missing.append(MissingEvidence.ALLOCATION_TAGS)  # nobody can be asked: the export has no tags
    elif owner is None or owner.share < OWNER_KNOWN_SHARE:
        missing.append(MissingEvidence.OWNER_CONFIRMATION)  # tagged, but this movement spans teams

    if kind is FindingKind.NEW_SERVICE:
        missing.append(MissingEvidence.ENVIRONMENT_CLASSIFICATION)
    elif any(d in available for d in _SHOWS_CAPACITY):
        missing.append(MissingEvidence.UTILIZATION_METRICS)
    else:
        missing.append(MissingEvidence.FINER_GRAINED_BILLING)

    missing.append(MissingEvidence.CHANGE_CONTEXT)
    return tuple(missing[:MAX_MISSING_EVIDENCE])


def _rank_key(c: Candidate) -> tuple[int, Decimal, str]:
    # Material changes first, then by size of the change (or amount, for unallocated spend).
    return (0 if c.material_absolute else 1, -c.delta, c.evidence_id)


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
    refs: set[str] = set()
    for k in keys:
        refs.update(view.refs.get(k, {}).get(month, []))
    return Candidate(
        evidence_id=evidence_id(file_sha256, FindingKind.UNALLOCATED, key, month),
        kind=FindingKind.UNALLOCATED,
        dimension=key[0],
        # One short word, not a list: the dimension says where the gap is, and the labels of rows
        # that have no label are not information.
        label="unallocated",
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
        source_refs=tuple(sorted(refs, key=_ref_order)[:MAX_REFS]),
    )
