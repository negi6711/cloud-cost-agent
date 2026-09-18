"""Cell-level parsing: costs, dates, currency markers, labels. Pure functions, no I/O."""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from functools import lru_cache

MAX_ABS_COST = Decimal("1e12")
MAX_LABEL_CHARS = 200

_PLAIN_NUMBER = re.compile(r"^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$")
_GROUPED_NUMBER = re.compile(r"^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$")
_DECIMAL_COMMA = re.compile(r"^[-+]?\d+(,\d+)?$")
_CURRENCY_PREFIX = re.compile(r"^[$€£¥]")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

CURRENCY_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY"}
_HEADER_CURRENCY = re.compile(r"\s*\(\s*([$€£¥]|[A-Z]{3})\s*\)\s*$")


class CellStatus(StrEnum):
    OK = "ok"
    EMPTY = "empty"
    INVALID = "invalid"
    OUT_OF_RANGE = "out_of_range"


def parse_cost(raw: str, *, decimal_comma: bool = False) -> tuple[CellStatus, Decimal | None]:
    """Parse a money cell. Invalid values are reported as invalid, never coerced to zero."""
    s = raw.strip()
    if not s:
        return CellStatus.EMPTY, None
    negative = False
    if s.startswith("(") and s.endswith(")"):  # accounting-style negative
        negative, s = True, s[1:-1].strip()
    if s[:1] in "-+" and _CURRENCY_PREFIX.match(s[1:]):  # "-$12.50"
        s = s[0] + s[2:]
    elif _CURRENCY_PREFIX.match(s):
        s = s[1:]
    s = s.strip()
    if decimal_comma and _DECIMAL_COMMA.match(s):
        s = s.replace(",", ".")
    elif _GROUPED_NUMBER.match(s):
        s = s.replace(",", "")
    if not _PLAIN_NUMBER.match(s):
        return CellStatus.INVALID, None
    try:
        value = Decimal(s)
    except InvalidOperation:
        return CellStatus.INVALID, None
    if not value.is_finite():
        return CellStatus.INVALID, None
    if negative:
        if value < 0:
            return CellStatus.INVALID, None  # "(-5)" is not a number anyone meant
        value = -value
    if abs(value) > MAX_ABS_COST:
        return CellStatus.OUT_OF_RANGE, None
    return CellStatus.OK, value


_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ][0-9:.+\-Z]*)?$")
_SLASH_DATE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")


class SlashOrder(StrEnum):
    MDY = "mdy"
    DMY = "dmy"


def slash_parts(raw: str) -> tuple[int, int, int] | None:
    m = _SLASH_DATE.match(raw.strip())
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


@lru_cache(maxsize=4096)  # exports repeat the same few hundred dates
def parse_date(raw: str, slash_order: SlashOrder = SlashOrder.MDY) -> date | None:
    """ISO dates (YYYY-MM-DD, YYYY-MM, with optional time) and slash dates in a known order."""
    s = raw.strip()
    m = _ISO_DATE.match(s)
    try:
        if m:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3) or 1))
        parts = slash_parts(s)
        if parts:
            a, b, year = parts
            month, day = (a, b) if slash_order is SlashOrder.MDY else (b, a)
            return date(year, month, day)
    except ValueError:
        return None
    return None


def infer_slash_order(values: list[str]) -> tuple[SlashOrder, bool]:
    """Decide M/D/Y vs D/M/Y from the whole column. Returns (order, assumed) where `assumed` means
    every date was ambiguous and the US order (AWS's default) was assumed."""
    firsts, seconds = [], []
    for v in values:
        parts = slash_parts(v)
        if parts:
            firsts.append(parts[0])
            seconds.append(parts[1])
    if any(f > 12 for f in firsts):
        return SlashOrder.DMY, False
    if any(s > 12 for s in seconds):
        return SlashOrder.MDY, False
    return SlashOrder.MDY, bool(firsts)


def split_header_currency(header: str) -> tuple[str, str | None]:
    """'Amazon EC2($)' -> ('Amazon EC2', 'USD'); 'Amazon EC2' -> ('Amazon EC2', None)."""
    m = _HEADER_CURRENCY.search(header)
    if not m:
        return header.strip(), None
    marker = m.group(1)
    return header[: m.start()].strip(), CURRENCY_SYMBOLS.get(marker, marker)


@lru_cache(maxsize=16384)  # labels repeat on every row
def clean_label(raw: str) -> str:
    """Labels from the file are untrusted data: strip control characters and bound the length."""
    return _CONTROL.sub(" ", raw).strip()[:MAX_LABEL_CHARS]


_UNALLOCATED = re.compile(r"^(no\b.*|others?|\(none\)|none|untagged|unknown|n/a|not tagged)$", re.IGNORECASE)


@lru_cache(maxsize=16384)
def is_unallocated_label(label: str) -> bool:
    """Cost Explorer's catch-alls such as 'No tag key', 'No linked account', 'Others'."""
    return bool(_UNALLOCATED.match(label.strip()))
