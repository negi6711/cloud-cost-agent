"""Explanation providers. The template provider is always available and uses only computed facts.

An explanation provider may phrase facts; it can never change a number, a category, a confidence
gate or a policy result. It receives the already-decided category.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Protocol

from cca.snapshots.types import (
    MISSING_EVIDENCE_LABELS,
    Candidate,
    Category,
    FindingKind,
    MissingEvidence,
)

_SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£"}


@dataclass(frozen=True)
class Statement:
    text: str
    refs: tuple[str, ...] = ()


@dataclass(frozen=True)
class Card:
    title: str
    what_changed: str
    what_we_know: tuple[Statement, ...]
    missing: tuple[MissingEvidence, ...]
    next_action: str
    source: str


@dataclass(frozen=True)
class ExplanationInput:
    candidate: Candidate
    final_category: Category
    currency: str | None
    missing: tuple[MissingEvidence, ...]  # ordered: most important first
    ownership_visible: bool
    total_change: Decimal | None  # whole-bill change between the compared months


class ExplanationProvider(Protocol):
    name: str

    def explain(self, data: ExplanationInput) -> Card: ...


def money(amount: Decimal, currency: str | None) -> str:
    value = f"{abs(amount):,.2f}"
    sign = "-" if amount < 0 else ""
    symbol = _SYMBOLS.get(currency or "")
    if symbol:
        return f"{sign}{symbol}{value}"
    return f"{sign}{value} {currency}" if currency else f"{sign}{value}"


def percent(ratio: Decimal) -> str:
    """Round half up (as the web app does), e.g. 0.2955 -> 29.6%."""
    return f"{(ratio * 100).quantize(Decimal('0.1'), rounding=ROUND_HALF_UP)}%"


def month_name(d: date) -> str:
    return f"{d:%B %Y}"


def _refs_text(refs: tuple[str, ...]) -> str:
    shown = ", ".join(refs[:4])
    return f"{shown} and {len(refs) - 4} more" if len(refs) > 4 else shown


def next_action(category: Category, missing: tuple[MissingEvidence, ...], month: date) -> str:
    """Safest next step for the decided category. Never a resize, delete, stop or purchase."""
    to_collect = [MISSING_EVIDENCE_LABELS[m] for m in missing
                  if m not in (MissingEvidence.NONE, MissingEvidence.OWNER_CONFIRMATION)]
    collect = f" and collect {to_collect[0]}" if to_collect else ""
    if category is Category.REQUEST_EVIDENCE:
        return f"Confirm which team owns this spend{collect} before considering a cost change."
    if category is Category.INVESTIGATE:
        return f"Ask the owning team what changed in {month_name(month)}{collect} before deciding anything."
    if category is Category.ESCALATE:
        return ("Raise this with engineering leadership: the change is large relative to the bill. "
                "Confirm the owner and the cause before any cost change.")
    return "No action yet. Check again after the next complete month."


class TemplateExplanationProvider:
    name = "template"

    def explain(self, data: ExplanationInput) -> Card:
        c, cur = data.candidate, data.currency
        month = month_name(c.current_month)
        know: list[Statement] = []

        if c.kind is FindingKind.NEW_SERVICE:
            title = f"New service: {c.label}"
            what = (f"{c.label} first appeared in {month} at {money(c.current, cur)}, "
                    f"{percent(c.share_of_current)} of that month's spend. It had no charges earlier in this file.")
            know.append(Statement(f"Billing data shows {money(c.current, cur)} in {month}.", c.source_refs))
        elif c.kind is FindingKind.UNALLOCATED:
            title = f"{percent(c.share_of_current)} of {month} spend has no owner allocation"
            what = (f"{money(c.current, cur)} ({percent(c.share_of_current)}) of {month} spend is not attributed "
                    f"to any {c.dimension.replace('_', ' ')} value ({c.label}).")
            know.append(Statement(f"Unallocated spend in {month}: {money(c.current, cur)}.", c.source_refs))
        else:
            assert c.baseline is not None and c.baseline_month is not None
            title = f"{c.label} up {money(c.delta, cur)}/month"
            change = f" ({percent(c.delta_pct)})" if c.delta_pct is not None else ""
            what = (f"{c.label} rose from {money(c.baseline, cur)} in {month_name(c.baseline_month)} to "
                    f"{money(c.current, cur)} in {month}, an increase of {money(c.delta, cur)}{change}.")
            know.append(Statement(f"Billing data confirms both months for this {c.dimension.replace('_', ' ')}.",
                                  c.source_refs))
            if data.total_change is not None and data.total_change > 0:
                share = min(Decimal(1), c.delta / data.total_change)
                know.append(Statement(f"It accounts for {percent(share)} of the whole bill's increase between "
                                      f"those months."))

        if not data.ownership_visible and c.kind is not FindingKind.UNALLOCATED:
            know.append(Statement("No team or allocation tag is present in this export, so the owner is not visible."))
        if c.source_refs:
            know.append(Statement(f"Source cells in the uploaded file: {_refs_text(c.source_refs)}."))

        return Card(
            title=title,
            what_changed=what,
            what_we_know=tuple(know),
            missing=data.missing,
            next_action=next_action(data.final_category, data.missing, c.current_month),
            source=self.name,
        )
