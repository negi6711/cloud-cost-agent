"""Parser output types. Everything here is in memory only; parsed rows are never persisted or logged."""

from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum
from typing import Any


class Layout(StrEnum):
    COST_EXPLORER_WIDE = "cost_explorer_wide"  # columns = group values, rows = periods
    LONG = "long"  # one row per (date, dimensions, cost)


class Granularity(StrEnum):
    MONTHLY = "monthly"
    DAILY = "daily"
    IRREGULAR = "irregular"


class Severity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


@dataclass(frozen=True)
class Issue:
    """A data-quality finding shown to the user. `message` is ours, never copied from the file."""

    code: str
    severity: Severity
    message: str
    count: int | None = None
    detail: dict[str, Any] | None = None

    def to_json(self, stage: str = "parse") -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "severity": str(self.severity), "stage": stage, "message": self.message}
        if self.count is not None:
            out["count"] = self.count
        if self.detail:
            out["detail"] = self.detail
        return out


@dataclass(frozen=True)
class Rejection:
    """Why a line or cell was not accepted. References positions, never cell contents."""

    line: int
    reason: str
    column: int | None = None


@dataclass(frozen=True)
class CostRecord:
    """One normalized cost fact with a pointer back to its source position (evidence)."""

    period_start: date
    dimensions: tuple[tuple[str, str], ...]  # sorted (dimension_type, label) pairs
    cost: Decimal
    currency: str | None
    line: int
    column: int | None = None
    unallocated: bool = False

    def dimension(self, name: str) -> str | None:
        for key, value in self.dimensions:
            if key == name:
                return value
        return None

    @property
    def source_ref(self) -> str:
        return f"L{self.line}" if self.column is None else f"L{self.line}:C{self.column}"


@dataclass(frozen=True)
class MonthCoverage:
    month_start: date
    complete: bool
    # why incomplete: "starts_mid_month", "month_to_date", "missing_days", "ends_mid_month"
    reason: str | None = None


@dataclass
class ParseStats:
    lines_seen: int = 0
    lines_accepted: int = 0
    lines_rejected: int = 0
    cells_rejected: int = 0
    empty_cells: int = 0
    duplicate_lines: int = 0


@dataclass
class ParseResult:
    layout: Layout
    delimiter: str
    had_bom: bool
    primary_dimension: str
    dimension_label: str
    dimensions_available: tuple[str, ...]
    currency: str | None
    granularity: Granularity
    records: list[CostRecord]
    months: list[MonthCoverage]
    stats: ParseStats
    issues: list[Issue] = field(default_factory=list)
    rejections: list[Rejection] = field(default_factory=list)

    @property
    def total_cost(self) -> Decimal:
        return sum((r.cost for r in self.records), Decimal(0))

    @property
    def period_start(self) -> date | None:
        return min((r.period_start for r in self.records), default=None)

    @property
    def period_end(self) -> date | None:
        """Last day covered: month end for monthly data, the last date otherwise."""
        last = max((r.period_start for r in self.records), default=None)
        if last is None or self.granularity is not Granularity.MONTHLY:
            return last
        return last.replace(day=calendar.monthrange(last.year, last.month)[1])


class ParseError(Exception):
    """The file cannot be analyzed at all. `message` is user-facing and actionable."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def to_issue(self) -> Issue:
        return Issue(self.code, Severity.ERROR, self.message)
