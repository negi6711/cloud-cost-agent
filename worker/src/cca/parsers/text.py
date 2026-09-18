"""Bytes -> rows: encoding, delimiter detection and CSV tokenizing with hard limits."""

from __future__ import annotations

import csv
import io
from collections import Counter

from cca.parsers.model import ParseError

UTF8_BOM = b"\xef\xbb\xbf"
DELIMITERS = (",", ";", "\t", "|")
MAX_LINES = 1_000_000
MAX_COLUMNS = 1_000
MAX_FIELD_CHARS = 10_000
_SAMPLE_LINES = 50


def decode(data: bytes) -> tuple[str, bool]:
    """Strict UTF-8 (optional BOM). Returns (text, had_bom)."""
    if not data.strip():
        raise ParseError("empty_file", "The file is empty.")
    had_bom = data.startswith(UTF8_BOM)
    if had_bom:
        data = data[len(UTF8_BOM) :]
    if b"\x00" in data:
        raise ParseError("binary_content", "The file contains binary data. Upload the CSV export from AWS Cost Explorer.")
    try:
        return data.decode("utf-8"), had_bom
    except UnicodeDecodeError as exc:
        raise ParseError("not_utf8", "The file is not UTF-8 text. Re-export it as a UTF-8 CSV.") from exc


def detect_delimiter(text: str) -> str:
    """Pick the delimiter that splits the first lines into the most columns most consistently."""
    sample = [line for line in text.splitlines()[:_SAMPLE_LINES] if line.strip()]
    best, best_score = ",", (0, 0)
    for delim in DELIMITERS:
        widths = [len(row) for row in csv.reader(sample, delimiter=delim)]
        if not widths:
            continue
        width, freq = Counter(widths).most_common(1)[0]
        score = (freq if width > 1 else 0, width)
        if score > best_score:
            best, best_score = delim, score
    if best_score[0] == 0:
        raise ParseError(
            "not_delimited",
            "The file does not look like a CSV: no comma, semicolon, tab or pipe separated columns were found.",
        )
    return best


def read_rows(text: str, delimiter: str) -> list[tuple[int, list[str]]]:
    """(1-based line number, fields) for each non-blank record, with size limits enforced."""
    csv.field_size_limit(MAX_FIELD_CHARS)
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=False)
    rows: list[tuple[int, list[str]]] = []
    try:
        for fields in reader:
            if reader.line_num > MAX_LINES:
                raise ParseError("too_many_rows", "The file has more than 1,000,000 lines. Export a shorter date range or a monthly view.")
            if len(fields) > MAX_COLUMNS:
                raise ParseError("too_many_columns", "The file has more than 1,000 columns. Group by fewer values in Cost Explorer.")
            if any(f.strip() for f in fields):
                rows.append((reader.line_num, fields))
    except csv.Error as exc:
        raise ParseError("malformed_csv", "The CSV could not be read (for example, an unclosed quote or an oversized field).") from exc
    if not rows:
        raise ParseError("empty_file", "The file is empty.")
    return rows
