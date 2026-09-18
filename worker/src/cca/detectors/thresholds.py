"""PROVISIONAL materiality rules (docs/product-spec.md §7). Not customer policy; tune with real data.

    material_change_absolute = max(500 per month, 5% of covered monthly spend)
    material_change_relative = 20% period-over-period increase
    new_service_threshold    = 5% of the current month's spend
    unknown_allocation       = 10% of the current month's spend

Amounts are in the file's currency (500 means 500 EUR for a EUR export).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

PROVISIONAL = True

MATERIAL_ABS_FLOOR = Decimal("500")
MATERIAL_ABS_SHARE = Decimal("0.05")
MATERIAL_RELATIVE = Decimal("0.20")
# A relative-only increase must still be at least this share of the absolute threshold, so a
# $5 -> $10 change (100%) never becomes a finding.
RELATIVE_MIN_SHARE_OF_ABS = Decimal("0.25")
NEW_SERVICE_SHARE = Decimal("0.05")
UNALLOCATED_SHARE = Decimal("0.10")
# Severity bands, in multiples of the absolute threshold.
HIGH_SEVERITY_MULTIPLE = Decimal("3")
# Findings sent for classification and shown on the snapshot.
MAX_FINDINGS = 10
MAX_SECONDARY_DIMENSION_FINDINGS = 3
# Below this data-readiness score the policy gate forces REQUEST_EVIDENCE.
READINESS_REQUEST_EVIDENCE_BELOW = 50


@dataclass(frozen=True)
class Thresholds:
    covered_monthly_spend: Decimal
    material_absolute: Decimal
    material_relative: Decimal
    relative_min_delta: Decimal
    new_service_min: Decimal
    unallocated_share: Decimal

    def to_json(self) -> dict[str, str | bool]:
        return {
            "provisional": PROVISIONAL,
            "covered_monthly_spend": str(self.covered_monthly_spend),
            "material_absolute": str(self.material_absolute),
            "material_relative": str(self.material_relative),
            "new_service_min": str(self.new_service_min),
            "unallocated_share": str(self.unallocated_share),
        }


def thresholds_for(covered_monthly_spend: Decimal, current_month_total: Decimal) -> Thresholds:
    absolute = max(MATERIAL_ABS_FLOOR, (MATERIAL_ABS_SHARE * covered_monthly_spend).quantize(Decimal("0.01")))
    return Thresholds(
        covered_monthly_spend=covered_monthly_spend,
        material_absolute=absolute,
        material_relative=MATERIAL_RELATIVE,
        relative_min_delta=(absolute * RELATIVE_MIN_SHARE_OF_ABS).quantize(Decimal("0.01")),
        new_service_min=(NEW_SERVICE_SHARE * current_month_total).quantize(Decimal("0.01")),
        unallocated_share=UNALLOCATED_SHARE,
    )
