"""Decision vocabulary shared by detectors, the policy gate, explanations and the model providers.

The category enum is the complete set of live decisions. RESIZE, DELETE, STOP and BUY COMMITMENT do
not exist here, so no code path (and no model answer) can produce them from billing-only data.
The same values are enforced by a CHECK constraint on snapshot_finding.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from enum import StrEnum


@dataclass(frozen=True)
class Component:
    """Part of a movement, described by a different grouping: "of the +$19,198 on Amazon EC2,
    +$9,627 was EBS:gp3". Amounts come from the same rows, so they never add to more than the
    movement itself."""

    dimension: str
    label: str
    delta: Decimal
    share: Decimal  # of the parent finding's delta


@dataclass(frozen=True)
class UsageSplit:
    """How much of a movement was more usage, and how much was a changed unit price.

    The only question a bill can settle on its own, and the one that decides who the reader should
    talk to: flat hours at a higher rate is a commitment or pricing event, not a deployment.

    Computed only when every row behind the finding reports a quantity in the same unit, because a
    quantity is meaningless across units (you cannot add GB-months to requests).

        delta_cost = volume_effect + rate_effect
        volume_effect = (qty_current - qty_baseline) * rate_baseline
        rate_effect   = (rate_current - rate_baseline) * qty_current
    """

    volume_effect: Decimal
    rate_effect: Decimal
    #: Quantities are only comparable within one unit, so a service billed in both vCPU-hours and
    #: GB-hours still gets effects (money is money) but no single usage figure to quote.
    unit: str | None = None
    quantity_baseline: Decimal | None = None
    quantity_current: Decimal | None = None
    rate_baseline: Decimal | None = None
    rate_current: Decimal | None = None

    @property
    def dominant(self) -> str:
        """"volume", "rate", or "mixed" when neither explains most of the movement."""
        total = abs(self.volume_effect) + abs(self.rate_effect)
        if total == 0:
            return "mixed"
        share = abs(self.volume_effect) / total
        if share >= Decimal("0.70"):
            return "volume"
        if share <= Decimal("0.30"):
            return "rate"
        return "mixed"

    @property
    def quantity_change(self) -> Decimal | None:
        if not self.quantity_baseline or self.quantity_current is None:
            return None
        return (self.quantity_current / self.quantity_baseline - 1).quantize(Decimal("0.0001"))


class Category(StrEnum):
    INVESTIGATE = "INVESTIGATE"
    REQUEST_EVIDENCE = "REQUEST_EVIDENCE"
    MONITOR = "MONITOR"
    ESCALATE = "ESCALATE"


class FindingKind(StrEnum):
    MATERIAL_INCREASE = "material_increase"
    NEW_SERVICE = "new_service"
    UNALLOCATED = "unallocated_spend"


class Severity(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class MissingEvidence(StrEnum):
    UTILIZATION_METRICS = "utilization_metrics"
    OWNER_CONFIRMATION = "owner_confirmation"
    ENVIRONMENT_CLASSIFICATION = "environment_classification"
    ALLOCATION_TAGS = "allocation_tags"
    CHANGE_CONTEXT = "change_context"
    COMMITMENT_COVERAGE = "commitment_coverage"
    FINER_GRAINED_BILLING = "finer_grained_billing"
    NONE = "none"


MISSING_EVIDENCE_LABELS: dict[MissingEvidence, str] = {
    MissingEvidence.UTILIZATION_METRICS: "CloudWatch utilization for the affected resources",
    MissingEvidence.OWNER_CONFIRMATION: "confirmation of which team owns this spend",
    MissingEvidence.ENVIRONMENT_CLASSIFICATION: "whether this is production or non-production",
    MissingEvidence.ALLOCATION_TAGS: "team or cost-allocation tags",
    MissingEvidence.CHANGE_CONTEXT: "the deployment, launch or configuration change behind it",
    MissingEvidence.COMMITMENT_COVERAGE: "Savings Plans or Reserved Instance coverage",
    MissingEvidence.FINER_GRAINED_BILLING: "resource-level billing data (Cost and Usage Report)",
    MissingEvidence.NONE: "nothing further",
}


class OwnerGroup(StrEnum):
    PLATFORM_INFRASTRUCTURE = "platform_infrastructure"
    ML_AI = "ml_ai"
    APPLICATION_ENGINEERING = "application_engineering"
    DATA = "data"
    SECURITY = "security"
    FINANCE = "finance"
    UNKNOWN = "unknown"


OWNER_LABELS: dict[OwnerGroup, str] = {
    OwnerGroup.PLATFORM_INFRASTRUCTURE: "Platform / Infrastructure",
    OwnerGroup.ML_AI: "ML / AI",
    OwnerGroup.APPLICATION_ENGINEERING: "Application Engineering",
    OwnerGroup.DATA: "Data",
    OwnerGroup.SECURITY: "Security",
    OwnerGroup.FINANCE: "Finance",
    OwnerGroup.UNKNOWN: "Unknown",
}


@dataclass(frozen=True)
class Candidate:
    """A deterministic candidate finding. Every number here is computed by code, never by a model."""

    evidence_id: str
    kind: FindingKind
    dimension: str
    label: str
    current_month: date
    baseline_month: date | None
    current: Decimal
    baseline: Decimal | None
    delta: Decimal
    delta_pct: Decimal | None  # None when the baseline is zero or absent
    share_of_current: Decimal  # of the current month's total
    material_absolute: bool
    material_relative: bool
    severity: Severity
    default_category: Category
    missing_evidence: tuple[MissingEvidence, ...]
    history: tuple[tuple[date, Decimal], ...]  # oldest first, up to 6 months
    source_refs: tuple[str, ...]  # positions in the uploaded file, e.g. "L5:C7"
    #: What this movement is made of, seen through the other groupings in the same export. These are
    #: slices of the same rows, so they are evidence inside one finding, never findings of their own.
    components: tuple[Component, ...] = ()
    #: Whether the money moved because of more usage or a changed price. None when the export has no
    #: usage column (every Cost Explorer export) or mixes units within the finding.
    usage_split: UsageSplit | None = None

    @property
    def material(self) -> bool:
        return self.material_absolute or self.material_relative
