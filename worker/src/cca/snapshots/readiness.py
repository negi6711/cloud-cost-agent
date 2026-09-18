"""Data-readiness score (0-100): how far the file can support a decision. PROVISIONAL weights.

| Component          | Max | Full marks when                                              |
|--------------------|-----|--------------------------------------------------------------|
| periods            | 30  | two consecutive complete months to compare                   |
| row_quality        | 20  | no rejected rows or cells (0 at >= 20% rejected)             |
| reconciliation     | 10  | the file's own totals match and no conflicting duplicates    |
| currency           | 10  | exactly one known currency                                   |
| duplicates         |  5  | no exact duplicate rows                                      |
| dimension_coverage | 10  | service plus account or region                               |
| allocation         | 15  | an ownership dimension (tag/account/cost category) with < 10% unallocated |
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from cca.detectors.core import Detection
from cca.parsers.model import ParseResult

_OWNERSHIP_DIMENSIONS = {"tag", "account", "cost_category"}


@dataclass(frozen=True)
class Readiness:
    score: int
    components: dict[str, int]

    def to_json(self) -> dict[str, object]:
        return {"score": self.score, "components": self.components, "provisional": True}


def readiness(result: ParseResult, detection: Detection) -> Readiness:
    codes = {i.code for i in result.issues}
    complete = [m for m in result.months if m.complete]

    if detection.comparison:
        periods = 30
    elif len(complete) >= 2:
        periods = 20
    elif complete:
        periods = 10
    else:
        periods = 0

    bad = result.stats.lines_rejected + result.stats.cells_rejected
    ratio = Decimal(bad) / Decimal(max(1, len(result.records) + bad))
    row_quality = max(0, int((20 * (1 - min(Decimal(1), ratio * 5))).to_integral_value()))

    reconciliation = 0 if codes & {"totals_do_not_reconcile", "conflicting_duplicate_periods",
                                   "conflicting_duplicate_keys"} else 10
    if "mixed_currencies" in codes:
        currency = 0
    elif result.currency:
        currency = 10
    else:
        currency = 5
    duplicates = 0 if result.stats.duplicate_lines else 5

    dims = set(result.dimensions_available)
    dimension_coverage = (5 if "service" in dims else 0) + (5 if dims & {"account", "region"} else 0)

    if dims & _OWNERSHIP_DIMENSIONS:
        unallocated = detection.unallocated_share or Decimal(0)
        allocation = 15 if unallocated < detection.thresholds.unallocated_share else 5
    else:
        allocation = 5  # ownership is not visible in a service-only export

    components = {
        "periods": periods,
        "row_quality": row_quality,
        "reconciliation": reconciliation,
        "currency": currency,
        "duplicates": duplicates,
        "dimension_coverage": dimension_coverage,
        "allocation": allocation,
    }
    return Readiness(sum(components.values()), components)
