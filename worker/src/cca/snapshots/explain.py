"""Explanation providers. The template provider is always available and uses only computed facts.

An explanation provider may phrase facts; it can never change a number, a category, a confidence
gate or a policy result. It receives the already-decided category.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Protocol

from cca.detectors.core import OWNER_KNOWN_SHARE
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


# What is actually missing from a row that could not be attributed. The keys are dimension names;
# anything else (including "mixed", where different rows are missing different things) falls back.
# How to name the grouping a component came from, in a sentence.
_COMPONENT_LABEL = {
    "tag": "team tag",
    "account": "account",
    "region": "region",
    "service": "service",
    "usage_type": "usage type",
    "instance_type": "instance type",
    "operation": "API operation",
    "charge_type": "charge type",
    "cost_category": "cost category",
    "availability_zone": "availability zone",
}

_UNALLOCATED_GAP = {
    "tag": "team tag",
    "account": "account",
    "region": "region",
    "service": "service name",
    "usage_type": "usage type",
    "cost_category": "cost category",
}


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


def next_action(
    category: Category,
    missing: tuple[MissingEvidence, ...],
    month: date,
    owner: str | None = None,
) -> str:
    """Safest next step for the decided category. Never a resize, delete, stop or purchase.

    `owner` is a team the export itself names for nearly all of this movement. Telling someone to
    "confirm which team owns this spend" when their own tags already say so wastes the one sentence
    the card has to be useful.
    """
    to_collect = [MISSING_EVIDENCE_LABELS[m] for m in missing
                  if m not in (MissingEvidence.NONE, MissingEvidence.OWNER_CONFIRMATION)]
    collect = f" and collect {to_collect[0]}" if to_collect else ""
    if category is Category.REQUEST_EVIDENCE:
        wanted = to_collect[0] if to_collect else "the detail behind it"
        if owner:
            return f"Your tags put this spend with {owner}: ask them for {wanted} before considering a cost change."
        if MissingEvidence.ALLOCATION_TAGS in missing:
            # "Confirm who owns it and collect allocation tags" asks for the same thing twice.
            return ("Tag this spend to a team, or add a cost category, so it can be attributed "
                    "before considering a cost change.")
        return f"Confirm which team owns this spend{collect} before considering a cost change."
    if category is Category.INVESTIGATE:
        who = owner or "the owning team"
        return f"Ask {who} what changed in {month_name(month)}{collect} before deciding anything."
    if category is Category.ESCALATE:
        cause = f"confirm the cause with {owner}" if owner else "confirm who owns it and what caused it"
        return ("Large relative to the whole bill, so raise it in this month's cost review rather "
                f"than leaving it for next month: {cause} before any cost change.")
    return "No action yet. Check again after the next complete month."


def owner_from_tags(c: Candidate) -> str | None:
    """The team the export itself puts behind nearly all of this movement, if it names one."""
    for part in c.components:
        if part.dimension in ("tag", "cost_category") and part.share >= OWNER_KNOWN_SHARE:
            return part.label
    return None


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
            where = _UNALLOCATED_GAP.get(c.dimension, "value in one or more of its grouping columns")
            what = (f"{money(c.current, cur)} ({percent(c.share_of_current)}) of {month} spend sits on rows with "
                    f"no {where}, so the export cannot say who owns it.")
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
            for part in c.components:
                # The same rows seen through another grouping, so this narrows the movement down
                # rather than adding to it.
                where = _COMPONENT_LABEL.get(part.dimension, part.dimension.replace("_", " "))
                know.append(Statement(
                    f"All of it is {part.label} ({where})." if part.share >= Decimal("0.99")
                    else f"{money(part.delta, cur)} of it ({percent(part.share)}) is {part.label} ({where})."))

        if not data.ownership_visible and c.kind is not FindingKind.UNALLOCATED:
            know.append(Statement("No team or allocation tag is present in this export, so the owner is not visible."))
        if c.source_refs:
            know.append(Statement(f"Source cells in the uploaded file: {_refs_text(c.source_refs)}."))

        return Card(
            title=title,
            what_changed=what,
            what_we_know=tuple(know),
            missing=data.missing,
            next_action=next_action(data.final_category, data.missing, c.current_month, owner_from_tags(c)),
            source=self.name,
        )
