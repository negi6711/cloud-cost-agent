"""Layout detection and row normalization for AWS billing CSVs.

Supported:
* Cost Explorer "Download as CSV" (wide): first header cell names the group-by dimension, remaining
  headers are group values with a currency marker such as "($)", optional "Total costs($)" column,
  optional "<Dimension> total" row, then one row per period (date in the first column).
* Long: one row per date and dimension values, with a cost column (header aliases below).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from cca.parsers.model import CostRecord, Issue, Layout, ParseError, ParseStats, Rejection, Severity
from cca.parsers.values import (
    CellStatus,
    clean_label,
    infer_slash_order,
    is_unallocated_label,
    parse_cost,
    parse_date,
    parse_quantity,
    split_header_currency,
)

RECONCILE_TOLERANCE = Decimal("0.01")

# Wide layout: first header cell -> dimension type.
_WIDE_DIMENSIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"^service$", re.I), "service"),
    (re.compile(r"^(linked )?account( name)?$|^member account$", re.I), "account"),
    (re.compile(r"^region$", re.I), "region"),
    (re.compile(r"^usage type( group)?$", re.I), "usage_type"),
    (re.compile(r"^instance type( family)?$", re.I), "instance_type"),
    (re.compile(r"^api operation$", re.I), "operation"),
    (re.compile(r"^charge type$", re.I), "charge_type"),
    (re.compile(r"^availability zone$", re.I), "availability_zone"),
    (re.compile(r"^tag\b", re.I), "tag"),
    (re.compile(r"^cost categor", re.I), "cost_category"),
)

# Long layout: normalized header -> field.
_LONG_ALIASES: dict[str, tuple[str, ...]] = {
    "date": ("date", "period", "month", "start date", "usage start date", "bill period", "billing period",
             "time period", "time period start", "period start", "billing period start date", "start",
             "lineitem/usagestartdate", "line_item_usage_start_date", "bill/billingperiodstartdate"),
    # The end of the period a row covers. Used only to tell a truncated month from a complete one.
    "period_end": ("end date", "usage end date", "time period end", "period end", "billing period end date",
                   "lineitem/usageenddate", "line_item_usage_end_date", "bill/billingperiodenddate"),
    "cost": ("cost", "amount", "unblended cost", "unblendedcost", "blended cost", "net cost", "amortized cost",
             "net unblended cost", "net amortized cost", "cost amount", "total cost",
             "lineitem/unblendedcost", "line_item_unblended_cost"),
    "service": ("service", "service name", "product name", "product", "product code",
                "lineitem/productcode", "line_item_product_code"),
    "account": ("linked account name", "account name", "account", "linked account",
                "linked account id", "account id", "usage account id",
                "lineitem/usageaccountid", "line_item_usage_account_id"),
    "region": ("region", "product/region", "product_region"),
    "usage_type": ("usage type", "lineitem/usagetype", "line_item_usage_type"),
    # An ownership tag, if the export carries one: this is what lets a finding name a team.
    "tag": ("team", "owner", "cost center", "business unit", "resource tags user team",
            "resourcetags/user:team", "resourcetags/user:owner", "resourcetags/user:costcenter"),
    # Production or not. A bill cannot show whether spend is safe to touch, but it can show that the
    # movement is in staging, which changes who reads the finding and how fast.
    "environment": ("environment", "env", "stage", "resource tags user environment",
                    "resourcetags/user:environment", "resourcetags/user:env"),
    # Usage, Tax, Credit, Refund, RIFee, SavingsPlanCoveredUsage... "is this even actionable spend".
    "charge_type": ("charge type", "line item type", "record type",
                    "lineitem/lineitemtype", "line_item_line_item_type"),
    # How much was used, and of what. Not dimensions: see CostRecord.quantity.
    "usage_quantity": ("usage quantity", "usage amount", "quantity",
                       "lineitem/usageamount", "line_item_usage_amount"),
    "usage_unit": ("usage unit", "pricing unit", "lineitem/usageunit", "line_item_usage_unit",
                   "pricing/unit"),
    "currency": ("currency", "currency code", "lineitem/currencycode", "line_item_currency_code"),
    # AWS marks a row that covers only part of its period; we trust it over our own date arithmetic.
    "partial": ("is partial period", "ispartialperiod", "partial period", "partial"),
}
_LONG_DIMENSIONS = ("service", "account", "region", "usage_type", "tag", "environment", "charge_type")

#: Groupings that can say who owns spend. A blank region or usage type is untidy; a blank team is an
#: allocation gap, and only the second one belongs in "this spend has no owner".
UNALLOCATED_DIMENSIONS = ("tag", "cost_category", "account")


_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def _norm_header(h: str) -> str:
    """"TimePeriodStart" -> "time period start". CUR exports write headers in camelCase, Cost
    Explorer writes them with spaces, and both are common; the aliases below are the spaced form.
    Slash-qualified CUR names ("lineItem/UnblendedCost") are matched whole, lowercased."""
    base, _ = split_header_currency(h)
    if "/" in base:
        return base.strip().lower()
    spaced = _CAMEL.sub(" ", base.replace("_", " ").strip())
    return re.sub(r"\s+", " ", spaced).lower()


def map_long_columns(header: list[str]) -> dict[str, int]:
    """Alias order is priority order, not just a set: an export that carries both
    LinkedAccountName and LinkedAccountId should be read by name, because "prod-main up $4,256"
    is a sentence a person can act on and "555555555555 up $4,256" is not."""
    mapping: dict[str, int] = {}
    normalized = [_norm_header(h) for h in header]
    for fieldname, aliases in _LONG_ALIASES.items():
        for alias in aliases:
            idx = next((i for i, h in enumerate(normalized) if alias in (h, h.replace(" ", "_"))), None)
            if idx is not None:
                mapping[fieldname] = idx
                break
    return mapping


@dataclass
class Normalized:
    layout: Layout
    primary_dimension: str
    dimension_label: str
    dimensions_available: tuple[str, ...]
    currency: str | None
    records: list[CostRecord]
    stats: ParseStats
    issues: list[Issue] = field(default_factory=list)
    rejections: list[Rejection] = field(default_factory=list)
    #: month start -> the last day that month's rows actually cover (from an end-date column).
    coverage_end: dict[date, date] = field(default_factory=dict)
    #: months the export itself marked as partial.
    flagged_partial: set[date] = field(default_factory=set)


def looks_long(header: list[str]) -> bool:
    """A date column plus a cost or a known dimension column. A long-looking file without a cost column
    is still routed here so the user is told exactly which column is missing."""
    cols = map_long_columns(header)
    return "date" in cols and ("cost" in cols or any(d in cols for d in _LONG_DIMENSIONS))


def looks_wide(rows: list[tuple[int, list[str]]]) -> bool:
    header = rows[0][1]
    if len(header) < 2:
        return False
    data = [fields[0] for _, fields in rows[1:] if not _is_total_label(fields[0])]
    if not data:
        return False
    order, _ = infer_slash_order(data)
    dated = sum(1 for v in data if parse_date(v, order) is not None)
    return dated >= max(1, len(data) // 2)


def _is_true(value: str) -> bool:
    return value.strip().lower() in {"true", "yes", "y", "1", "t"}


def _is_total_label(value: str) -> bool:
    v = value.strip().lower()
    return v == "total" or v.endswith(" total")


def _slash_issue(assumed: bool) -> list[Issue]:
    if not assumed:
        return []
    return [Issue("date_format_assumed", Severity.WARNING,
                  "Dates like 07/08/2026 were read as month/day/year (the AWS default). Check the detected period.")]


def _currency_issue(currencies: set[str]) -> Issue | None:
    if len(currencies) > 1:
        return Issue("mixed_currencies", Severity.ERROR,
                     "The file mixes currencies. Totals across currencies are not meaningful; export one currency.",
                     detail={"currencies": sorted(currencies)})
    return None


def normalize_wide(rows: list[tuple[int, list[str]]], *, decimal_comma: bool) -> Normalized:
    _header_line, header = rows[0]
    dimension_label = clean_label(header[0]) or "Group"
    dimension = next((d for pat, d in _WIDE_DIMENSIONS if pat.search(dimension_label)), "other")

    value_cols: list[tuple[int, str, str | None]] = []
    total_col: int | None = None
    currencies: set[str] = set()
    for idx, raw in enumerate(header[1:], start=1):
        label, currency = split_header_currency(raw)
        if currency:
            currencies.add(currency)
        if label.strip().lower().startswith("total"):
            total_col = idx
        else:
            value_cols.append((idx, clean_label(label), currency))
    if not value_cols:
        raise ParseError("missing_required_columns",
                         "No cost columns were found. Export from Cost Explorer with a group-by (for example, Service).")

    stats = ParseStats()
    issues: list[Issue] = []
    rejections: list[Rejection] = []
    records: list[CostRecord] = []
    order, assumed = infer_slash_order([f[0] for _, f in rows[1:]])
    issues += _slash_issue(assumed)

    totals_row: tuple[int, list[str]] | None = None
    seen_lines: dict[date, tuple[str, ...]] = {}
    conflicting_dates: set[date] = set()
    line_total_mismatches = 0
    column_sums: dict[int, Decimal] = {}

    for line, fields in rows[1:]:
        if _is_total_label(fields[0]):
            totals_row = (line, fields)
            continue
        stats.lines_seen += 1
        if len(fields) != len(header):
            stats.lines_rejected += 1
            rejections.append(Rejection(line, "field_count_mismatch"))
            continue
        period = parse_date(fields[0], order)
        if period is None:
            stats.lines_rejected += 1
            rejections.append(Rejection(line, "invalid_date", 1))
            continue
        signature = tuple(f.strip() for f in fields)
        previous = seen_lines.get(period)
        if previous == signature:
            stats.duplicate_lines += 1
            stats.lines_rejected += 1
            rejections.append(Rejection(line, "duplicate_row"))
            continue
        if previous is not None:
            conflicting_dates.add(period)
        seen_lines[period] = signature

        stats.lines_accepted += 1
        line_sum = Decimal(0)
        for col, label, col_currency in value_cols:
            status, value = parse_cost(fields[col], decimal_comma=decimal_comma)
            if status is CellStatus.EMPTY:
                stats.empty_cells += 1
                continue
            if value is None:
                stats.cells_rejected += 1
                rejections.append(Rejection(line, "invalid_number" if status is CellStatus.INVALID else "out_of_range", col + 1))
                continue
            line_sum += value
            column_sums[col] = column_sums.get(col, Decimal(0)) + value
            unallocated = dimension in UNALLOCATED_DIMENSIONS and is_unallocated_label(label)
            records.append(CostRecord(period, ((dimension, label),), value, col_currency,
                                      line, col + 1, unallocated))
        if total_col is not None:
            status, stated = parse_cost(fields[total_col], decimal_comma=decimal_comma)
            if stated is not None and abs(stated - line_sum) > RECONCILE_TOLERANCE:
                line_total_mismatches += 1

    column_mismatches = 0
    if totals_row is not None:
        _, tfields = totals_row
        for col, _label, _currency in value_cols:
            if col < len(tfields):
                _status, stated = parse_cost(tfields[col], decimal_comma=decimal_comma)
                if stated is not None and abs(stated - column_sums.get(col, Decimal(0))) > RECONCILE_TOLERANCE:
                    column_mismatches += 1

    if line_total_mismatches or column_mismatches:
        issues.append(Issue("totals_do_not_reconcile", Severity.WARNING,
                            "The file's own total row or column does not match the sum of its values. "
                            "Rows may have been edited or removed.",
                            count=line_total_mismatches + column_mismatches))
    if conflicting_dates:
        issues.append(Issue("conflicting_duplicate_periods", Severity.WARNING,
                            "The same period appears more than once with different values; both were kept.",
                            count=len(conflicting_dates)))
    if not currencies:
        issues.append(Issue("currency_unknown", Severity.WARNING,
                            "No currency marker such as ($) was found in the headers; amounts are unlabeled."))
    if (issue := _currency_issue(currencies)) is not None:
        issues.append(issue)

    return Normalized(Layout.COST_EXPLORER_WIDE, dimension, dimension_label, (dimension,),
                      next(iter(currencies)) if len(currencies) == 1 else None,
                      records, stats, issues, rejections)


def normalize_long(rows: list[tuple[int, list[str]]], *, decimal_comma: bool) -> Normalized:
    _, header = rows[0]
    cols = map_long_columns(header)
    dims = [d for d in _LONG_DIMENSIONS if d in cols]
    dim_columns = sorted((d, cols[d]) for d in dims)  # record dimensions are kept sorted by name
    missing = [f for f in ("date", "cost") if f not in cols]
    if missing or not dims:
        need = ", ".join(missing + ([] if dims else ["service (or account/region)"]))
        raise ParseError("missing_required_columns",
                         f"Required columns are missing: {need}. The file needs a date, a service (or account/region) "
                         "and a cost column.")
    header_currency = next((c for h in header if (c := split_header_currency(h)[1])), None)

    stats = ParseStats()
    issues: list[Issue] = []
    rejections: list[Rejection] = []
    records: list[CostRecord] = []
    order, assumed = infer_slash_order([f[cols["date"]] for _, f in rows[1:] if len(f) > cols["date"]])
    issues += _slash_issue(assumed)

    seen: set[tuple[str, ...]] = set()
    keys: dict[tuple[object, ...], Decimal] = {}
    conflicting = 0
    currencies: set[str] = set()
    coverage_end: dict[date, date] = {}
    flagged_partial: set[date] = set()

    for line, fields in rows[1:]:
        stats.lines_seen += 1
        if len(fields) != len(header):
            stats.lines_rejected += 1
            rejections.append(Rejection(line, "field_count_mismatch"))
            continue
        signature = tuple(f.strip() for f in fields)
        if signature in seen:
            stats.duplicate_lines += 1
            stats.lines_rejected += 1
            rejections.append(Rejection(line, "duplicate_row"))
            continue
        seen.add(signature)
        period = parse_date(fields[cols["date"]], order)
        if period is None:
            stats.lines_rejected += 1
            rejections.append(Rejection(line, "invalid_date", cols["date"] + 1))
            continue
        status, value = parse_cost(fields[cols["cost"]], decimal_comma=decimal_comma)
        if status is CellStatus.EMPTY:
            stats.lines_rejected += 1
            rejections.append(Rejection(line, "missing_cost", cols["cost"] + 1))
            continue
        if value is None:
            stats.lines_rejected += 1
            stats.cells_rejected += 1
            rejections.append(Rejection(line, "invalid_number" if status is CellStatus.INVALID else "out_of_range",
                                        cols["cost"] + 1))
            continue
        dimensions = tuple((d, clean_label(fields[c]) or "(blank)") for d, c in dim_columns)
        quantity = unit = None
        if "usage_quantity" in cols:
            q_status, q_value = parse_quantity(fields[cols["usage_quantity"]], decimal_comma=decimal_comma)
            if q_status is CellStatus.OK:
                quantity = q_value
                unit = clean_label(fields[cols["usage_unit"]]) if "usage_unit" in cols else None
            elif q_status is not CellStatus.EMPTY:
                # A cost row with an unreadable quantity is still a cost row: keep the money, drop
                # the usage, and never guess a number that decides "usage or price".
                stats.cells_rejected += 1
                rejections.append(Rejection(line, "invalid_number", cols["usage_quantity"] + 1))
        currency = clean_label(fields[cols["currency"]]).upper() if "currency" in cols else header_currency
        if currency:
            currencies.add(currency)
        key = (period, dimensions)
        if key in keys and keys[key] != value:
            conflicting += 1
        keys[key] = value
        unallocated = any(d in UNALLOCATED_DIMENSIONS and (is_unallocated_label(v) or v == "(blank)")
                          for d, v in dimensions)
        stats.lines_accepted += 1
        records.append(CostRecord(period, dimensions, value, currency, line, None, unallocated,
                                  quantity, unit))

        # How far this month's data reaches, so a truncated month is not compared as a whole one.
        month = period.replace(day=1)
        if "period_end" in cols:
            end = parse_date(fields[cols["period_end"]], order)
            if end is not None and end >= period:
                coverage_end[month] = max(coverage_end.get(month, end), end)
        if "partial" in cols and _is_true(fields[cols["partial"]]):
            flagged_partial.add(month)

    if conflicting:
        issues.append(Issue("conflicting_duplicate_keys", Severity.WARNING,
                            "Some date and dimension combinations appear more than once with different costs; "
                            "all were kept and summed.", count=conflicting))
    if not currencies:
        issues.append(Issue("currency_unknown", Severity.WARNING,
                            "No currency column or marker was found; amounts are unlabeled."))
    if (issue := _currency_issue(currencies)) is not None:
        issues.append(issue)

    primary = "service" if "service" in dims else dims[0]
    return Normalized(Layout.LONG, primary, primary.replace("_", " ").title(), tuple(dims),
                      next(iter(currencies)) if len(currencies) == 1 else None,
                      records, stats, issues, rejections, coverage_end, flagged_partial)
