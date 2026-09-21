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
    UsageSplit,
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


#: AWS writes units for machines. "$1.54 per Hrs" is not a sentence.
_UNIT_NAMES = {
    "hrs": "hour", "hours": "hour", "hour": "hour",
    "vcpu-hours": "vCPU-hour", "gb-hours": "GB-hour", "dpu-hours": "DPU-hour",
    "gb-mo": "GB-month", "gb-month": "GB-month", "gb-months": "GB-month",
    "requests": "request", "each": "unit", "quantity": "unit", "count": "unit",
}


def unit_name(unit: str) -> str:
    return _UNIT_NAMES.get(unit.strip().lower(), unit)


def quantity(amount: Decimal, unit: str) -> str:
    whole = amount.quantize(Decimal("1")) if amount == amount.to_integral_value() else amount
    return f"{whole:,} {unit_name(unit)}s" if whole != 1 else f"1 {unit_name(unit)}"


def unit_rate(amount: Decimal, currency: str | None, unit: str) -> str:
    """A unit price needs more than two decimals: $0.04 per vCPU-hour hides the whole story."""
    trimmed = amount.quantize(Decimal("0.000001")).normalize()
    exponent = trimmed.as_tuple().exponent
    if isinstance(exponent, int) and exponent > 0:  # normalize() turns 100 into 1E+2
        trimmed = trimmed.quantize(Decimal("0.01"))
    return f"{money(trimmed, currency)} per {unit_name(unit)}"


def usage_statement(split: UsageSplit, currency: str | None) -> Statement:
    """The one thing a bill can settle by itself: was it more usage, or a different price?"""
    priced = money(split.rate_effect, currency)
    used = money(split.volume_effect, currency)

    if not (split.unit and split.quantity_baseline is not None and split.quantity_current is not None
            and split.rate_baseline is not None and split.rate_current is not None):
        # Billed in several units, so the quantities cannot be added, but the money still can.
        lead = "This service is billed in more than one unit, so only the money is comparable:"
        if split.dominant == "rate":
            return Statement(f"{lead} {priced} of this change is a higher price, not more usage.")
        if split.dominant == "volume":
            return Statement(f"{lead} {used} of this change is more usage, at an unchanged rate.")
        return Statement(f"{lead} {used} of it is more usage and {priced} is a higher price.")

    moved = "" if split.quantity_change is None else f", {percent(split.quantity_change)}"
    usage = (f"Usage went from {quantity(split.quantity_baseline, split.unit)} to "
             f"{quantity(split.quantity_current, split.unit)}{moved}")
    rates = (f"the effective rate went from {unit_rate(split.rate_baseline, currency, split.unit)} "
             f"to {unit_rate(split.rate_current, currency, split.unit)}")
    if split.dominant == "rate":
        return Statement(f"{usage}. Usage barely moved and {rates}: {priced} of this change is "
                         "price, not more usage.")
    if split.dominant == "volume":
        return Statement(f"{usage}, at an effectively unchanged rate: {used} of this change is more usage.")
    return Statement(f"{usage}, and {rates}: {used} of the change is usage and {priced} is price.")


def next_action(
    category: Category,
    missing: tuple[MissingEvidence, ...],
    month: date,
    owner: str | None = None,
    split: UsageSplit | None = None,
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
        if split is not None and split.dominant == "rate":
            # "Ask what changed" sends someone to look for a deployment that did not happen.
            return (f"Usage did not move, so ask {who} what changed about price rather than about "
                    "workload: an expired Savings Plan or Reserved Instance, a shift off spot "
                    "capacity, or a region or instance-family change.")
        return f"Ask {who} what changed in {month_name(month)}{collect} before deciding anything."
    if category is Category.ESCALATE:
        if split is not None and split.dominant == "rate":
            who = f" with {owner}" if owner else ""
            return ("Large relative to the whole bill, so raise it in this month's cost review. "
                    f"Usage did not move, so check pricing and commitment coverage{who} first, "
                    "not the workload.")
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
            if c.usage_split is not None:
                know.append(usage_statement(c.usage_split, cur))
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
            next_action=next_action(data.final_category, data.missing, c.current_month,
                                    owner_from_tags(c), c.usage_split),
            source=self.name,
        )
