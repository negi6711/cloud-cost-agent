"""AWS billing CSV parsing: bytes in, normalized cost records and data-quality issues out.

Entry point: `parse_billing_export(data, today=...)`. Deterministic: the same bytes (and `today`)
always produce the same result. Raises `ParseError` only when nothing can be analyzed.
"""

from __future__ import annotations

import calendar
import itertools
from collections import Counter, defaultdict
from datetime import date

from cca.parsers.layouts import looks_long, looks_wide, normalize_long, normalize_wide
from cca.parsers.model import (
    CostRecord,
    Granularity,
    Issue,
    MonthCoverage,
    ParseError,
    ParseResult,
    Severity,
)
from cca.parsers.text import decode, detect_delimiter, read_rows
from cca.parsers.values import clean_label, is_unallocated_label, parse_date

__all__ = ["ParseError", "ParseResult", "parse_billing_export"]

_MAX_REJECTION_SAMPLES = 50


def parse_billing_export(data: bytes, *, today: date) -> ParseResult:
    try:
        return _parse(data, today)
    finally:
        # The caches hold labels from this customer's file; never let them outlive the parse.
        clean_label.cache_clear()
        is_unallocated_label.cache_clear()
        parse_date.cache_clear()


def _parse(data: bytes, today: date) -> ParseResult:
    text, had_bom = decode(data)
    delimiter = detect_delimiter(text)
    rows = read_rows(text, delimiter)
    if len(rows) < 2:
        raise ParseError("no_data_rows", "The file has a header but no data rows.")

    # A semicolon-delimited file usually comes from a locale that writes decimals with a comma.
    decimal_comma = delimiter == ";"
    header = rows[0][1]
    if looks_long(header):
        normalized = normalize_long(rows, decimal_comma=decimal_comma)
    elif looks_wide(rows):
        normalized = normalize_wide(rows, decimal_comma=decimal_comma)
    else:
        raise ParseError(
            "unsupported_layout",
            "This does not look like an AWS billing export. Expected a Cost Explorer CSV (dates in the first column, "
            "one column per service) or columns for date, service and cost.",
        )

    if not normalized.records:
        raise ParseError("no_valid_rows", "No rows could be read: every row had an invalid date or cost.")

    issues = list(normalized.issues)
    stats = normalized.stats
    if stats.lines_rejected or stats.cells_rejected:
        reasons = Counter(r.reason for r in normalized.rejections)
        issues.append(Issue("rows_rejected", Severity.WARNING,
                            "Some rows or values could not be read and were excluded (never counted as zero).",
                            count=stats.lines_rejected + stats.cells_rejected,
                            detail={"by_reason": dict(sorted(reasons.items()))}))
    if stats.duplicate_lines:
        issues.append(Issue("duplicate_rows", Severity.WARNING,
                            "Exact duplicate rows were found and counted once.", count=stats.duplicate_lines))
    if decimal_comma and any(r.cost != r.cost.to_integral_value() for r in normalized.records):
        issues.append(Issue("decimal_comma", Severity.INFO,
                            "Semicolon-separated file: commas were read as decimal separators."))
    credits = [r for r in normalized.records if r.cost < 0]
    if credits:
        issues.append(Issue("credits_present", Severity.INFO,
                            "Credits or refunds (negative amounts) are included in the totals.", count=len(credits)))

    granularity, months, period_issues = _periods(normalized.records, today)
    issues += period_issues

    return ParseResult(
        layout=normalized.layout,
        delimiter=delimiter,
        had_bom=had_bom,
        primary_dimension=normalized.primary_dimension,
        dimension_label=normalized.dimension_label,
        dimensions_available=normalized.dimensions_available,
        currency=normalized.currency,
        granularity=granularity,
        records=sorted(normalized.records, key=lambda r: (r.period_start, r.dimensions, r.line, r.column or 0)),
        months=months,
        stats=stats,
        issues=issues,
        rejections=normalized.rejections[:_MAX_REJECTION_SAMPLES],
    )


def _month(d: date) -> date:
    return d.replace(day=1)


def _periods(records: list[CostRecord], today: date) -> tuple[Granularity, list[MonthCoverage], list[Issue]]:
    dates = sorted({r.period_start for r in records})
    by_month: dict[date, set[date]] = defaultdict(set)
    for d in dates:
        by_month[_month(d)].add(d)

    one_per_month = all(len(days) == 1 for days in by_month.values())
    if one_per_month:
        granularity = Granularity.MONTHLY
    elif all((b - a).days == 1 for a, b in itertools.pairwise(dates)):
        granularity = Granularity.DAILY
    else:
        granularity = Granularity.IRREGULAR

    months: list[MonthCoverage] = []
    current_month = _month(today)
    for month in sorted(by_month):
        days = by_month[month]
        days_in_month = calendar.monthrange(month.year, month.month)[1]
        if month >= current_month:
            months.append(MonthCoverage(month, False, "month_to_date"))
        elif granularity is Granularity.MONTHLY and min(days).day != 1:
            months.append(MonthCoverage(month, False, "starts_mid_month"))
        elif granularity is not Granularity.MONTHLY and len(days) < days_in_month:
            months.append(MonthCoverage(month, False, "missing_days"))
        else:
            months.append(MonthCoverage(month, True))

    issues: list[Issue] = []
    partial = [m for m in months if not m.complete]
    if partial:
        issues.append(Issue(
            "partial_period", Severity.WARNING,
            "Some months are incomplete, so month-over-month changes involving them are not like-for-like.",
            count=len(partial),
            detail={"months": [f"{m.month_start:%Y-%m}:{m.reason}" for m in partial]},
        ))
    complete = [m for m in months if m.complete]
    if len(complete) < 2:
        issues.append(Issue(
            "insufficient_periods", Severity.WARNING,
            "Fewer than two complete months are covered, so period-over-period changes cannot be calculated. "
            "Export at least two full months.",
        ))
    if granularity is Granularity.IRREGULAR:
        issues.append(Issue("irregular_dates", Severity.WARNING,
                            "Dates are neither monthly nor consecutive days; periods were grouped by month."))
    return granularity, months, issues
