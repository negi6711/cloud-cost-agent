"""Monthly view of parsed records: totals per month and per (dimension, label), with source refs."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from cca.parsers.model import ParseResult

Key = tuple[str, str]  # (dimension, label)


@dataclass
class MonthlyView:
    months: list[date]
    complete: dict[date, bool]
    totals: dict[date, Decimal]
    series: dict[Key, dict[date, Decimal]]
    refs: dict[Key, dict[date, list[str]]]
    unallocated: set[Key]
    dimensions: tuple[str, ...]
    primary_dimension: str
    currency: str | None
    unallocated_totals: dict[date, Decimal] = field(default_factory=dict)

    def cost(self, key: Key, month: date) -> Decimal:
        return self.series.get(key, {}).get(month, Decimal(0))

    def keys(self, dimension: str) -> list[Key]:
        return sorted(k for k in self.series if k[0] == dimension)

    @property
    def complete_months(self) -> list[date]:
        return [m for m in self.months if self.complete[m]]

    def comparison(self) -> tuple[date, date] | None:
        """(baseline, current): the latest two consecutive complete months, if any."""
        complete = self.complete_months
        for current, baseline in zip(reversed(complete), reversed(complete[:-1]), strict=False):
            if _next_month(baseline) == current:
                return baseline, current
        return None

    def covered_monthly_spend(self) -> Decimal:
        """Mean monthly total over complete months (all months if none are complete)."""
        months = self.complete_months or self.months
        if not months:
            return Decimal(0)
        return (sum((self.totals[m] for m in months), Decimal(0)) / len(months)).quantize(Decimal("0.01"))


def _next_month(d: date) -> date:
    return date(d.year + 1, 1, 1) if d.month == 12 else date(d.year, d.month + 1, 1)


def build_monthly_view(result: ParseResult) -> MonthlyView:
    totals: dict[date, Decimal] = defaultdict(Decimal)
    series: dict[Key, dict[date, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    refs: dict[Key, dict[date, list[str]]] = defaultdict(lambda: defaultdict(list))
    unallocated: set[Key] = set()
    unallocated_totals: dict[date, Decimal] = defaultdict(Decimal)

    for record in result.records:
        month = record.period_start.replace(day=1)
        totals[month] += record.cost
        if record.unallocated:
            unallocated_totals[month] += record.cost
        for dimension, label in record.dimensions:
            key = (dimension, label)
            series[key][month] += record.cost
            refs[key][month].append(record.source_ref)
            if record.unallocated:
                unallocated.add(key)

    coverage = {m.month_start: m.complete for m in result.months}
    months = sorted(totals)
    return MonthlyView(
        months=months,
        complete={m: coverage.get(m, False) for m in months},
        totals=dict(totals),
        series={k: dict(v) for k, v in series.items()},
        refs={k: dict(v) for k, v in refs.items()},
        unallocated=unallocated,
        dimensions=result.dimensions_available,
        primary_dimension=result.primary_dimension,
        currency=result.currency,
        unallocated_totals=dict(unallocated_totals),
    )
