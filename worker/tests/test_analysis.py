from __future__ import annotations

import hashlib
import json
import re
from datetime import date
from decimal import Decimal

import pytest

from cca.parsers import parse_billing_export
from cca.providers.base import UnavailableProvider, UnavailableReason
from cca.settings import REPO_ROOT
from cca.snapshots.analyze import Analysis, analyze
from cca.snapshots.explain import TemplateExplanationProvider
from cca.snapshots.packet import canonical_json, packet_sha256
from cca.snapshots.types import Category, FindingKind, Severity

FIXTURES = REPO_ROOT / "fixtures"
TODAY = date(2026, 9, 18)
PROHIBITED = re.compile(r"\b(resize|rightsiz|delete|terminate|stop|shut ?down|purchase|buy|commit(ment)?s?)\b", re.I)


def run(data: bytes) -> Analysis:
    result = parse_billing_export(data, today=TODAY)
    return analyze(result, hashlib.sha256(data).hexdigest(), UnavailableProvider(UnavailableReason.DISABLED),
                   TemplateExplanationProvider(), 0.5)


def fixture(name: str) -> Analysis:
    return run((FIXTURES / name).read_bytes())


def wide(rows: dict[str, dict[str, str]]) -> bytes:
    """Build a small Cost Explorer style export: {month: {service: amount}}."""
    services = sorted({s for r in rows.values() for s in r})
    lines = ["Service," + ",".join(f"{s}($)" for s in services)]
    for month, values in rows.items():
        lines.append(month + "," + ",".join(values.get(s, "") for s in services))
    return ("\n".join(lines) + "\n").encode()


# ------------------------------------------------------------- canonical ---


def test_canonical_export_findings() -> None:
    a = fixture("valid_cost_explorer.csv")
    assert a.detection.comparison == (date(2026, 6, 1), date(2026, 7, 1))
    assert a.detection.thresholds.material_absolute == Decimal("500")  # max(500, 5% of 7671.25)
    found = [(f.candidate.kind, f.candidate.label, f.candidate.delta, f.decision.final_category) for f in a.findings]
    assert found == [
        (FindingKind.NEW_SERVICE, "Amazon Elastic Container Service", Decimal("1840.00"), Category.REQUEST_EVIDENCE),
        (FindingKind.MATERIAL_INCREASE, "Tax", Decimal("170.00"), Category.MONITOR),
    ]
    ecs = a.findings[0].candidate
    assert (ecs.severity, ecs.share_of_current) == (Severity.HIGH, Decimal("0.2018"))
    assert ecs.source_refs == ("L5:C7",)


def test_canonical_summary() -> None:
    s = fixture("valid_cost_explorer.csv").summary
    assert s["total"] == "23013.75"
    assert s["comparison"] == {"baseline_month": "2026-06", "current_month": "2026-07", "baseline_total": "7038.90",
                               "current_total": "9119.00", "delta": "2080.10", "delta_pct": "0.2955"}
    assert [t["label"] for t in s["top_items"]] == [
        "Amazon Elastic Compute Cloud - Compute", "Amazon Relational Database Service",
        "Amazon Elastic Container Service", "Tax", "Amazon Simple Storage Service"]
    assert s["top_items"][0] == {"label": "Amazon Elastic Compute Cloud - Compute", "cost": "12960.50", "share": "0.5632"}
    assert {g["code"] for g in s["data_gaps"]} == {"billing_only", "no_account_region", "no_ownership_dimension"}
    assert s["thresholds"]["provisional"] is True


def test_readiness_components_are_documented_and_sum() -> None:
    r = fixture("valid_cost_explorer.csv").readiness
    assert r.components == {"periods": 30, "row_quality": 20, "reconciliation": 10, "currency": 10,
                            "duplicates": 5, "dimension_coverage": 5, "allocation": 5}
    assert r.score == 85 == sum(r.components.values())


# ------------------------------------------------------------ thresholds ---


def test_absolute_threshold_scales_with_spend() -> None:
    a = run(wide({"2026-06-01": {"A": "40000", "B": "0"}, "2026-07-01": {"A": "40900", "B": "0"}}))
    assert a.detection.thresholds.material_absolute == Decimal("2022.50")  # 5% of 40450
    assert a.findings == []  # +900 is below 2022.50 and only 2.25%


def test_small_relative_change_is_not_a_finding() -> None:
    a = run(wide({"2026-06-01": {"Big": "10000", "Tiny": "5"}, "2026-07-01": {"Big": "10000", "Tiny": "10"}}))
    assert a.findings == []  # +100% but only $5


def test_relative_change_above_the_floor_is_monitor() -> None:
    a = run(wide({"2026-06-01": {"Big": "10000", "S3": "400"}, "2026-07-01": {"Big": "10000", "S3": "600"}}))
    [f] = a.findings
    assert (f.candidate.label, f.candidate.material_absolute, f.candidate.material_relative) == ("S3", False, True)
    assert f.decision.final_category is Category.MONITOR


def test_large_concentrated_increase_defaults_to_escalate() -> None:
    a = run(wide({"2026-06-01": {"EC2": "5000", "S3": "500"}, "2026-07-01": {"EC2": "9000", "S3": "500"}}))
    [f] = a.findings
    assert (f.candidate.severity, f.candidate.default_category) == (Severity.HIGH, Category.ESCALATE)


def test_decreases_are_never_findings() -> None:
    a = run(wide({"2026-06-01": {"EC2": "9000"}, "2026-07-01": {"EC2": "1000"}}))
    assert a.findings == []


def test_partial_months_are_never_compared() -> None:
    a = fixture("partial_period.csv")
    assert a.detection.comparison == (date(2026, 7, 1), date(2026, 8, 1))  # not the month-to-date September


def test_without_two_consecutive_complete_months_the_snapshot_abstains() -> None:
    a = run(wide({"2026-07-01": {"EC2": "100"}}))
    assert a.abstained and a.findings == []
    assert "no_comparison" in {g["code"] for g in a.summary["data_gaps"]}


def test_unallocated_spend_is_one_finding_not_two() -> None:
    a = fixture("valid_cost_explorer_by_tag.csv")
    [f] = a.findings
    assert f.candidate.kind is FindingKind.UNALLOCATED
    assert (f.candidate.current, f.candidate.share_of_current) == (Decimal("2400.00"), Decimal("0.2727"))
    assert f.decision.final_category is Category.REQUEST_EVIDENCE


def test_the_unallocated_card_names_the_gap_not_the_labels() -> None:
    """The rows behind this finding are the ones with no label, so listing labels was both wrong and
    a way to spray the file's own text across the report."""
    a = fixture("valid_cost_explorer_by_tag.csv")
    [f] = a.findings
    assert f.candidate.label == "unallocated"
    assert "no team tag" in f.card.what_changed and "cannot say who owns it" in f.card.what_changed
    # None of the file's own labels may appear: the rows behind this finding are the unlabelled ones.
    for label in ("platform", "data", "No tag key", "(blank)"):
        assert label not in f.card.what_changed


def test_source_references_are_listed_in_file_order() -> None:
    a = fixture("valid_long_format.csv")
    for f in a.findings:
        refs = [int(r.lstrip("L").split(":C")[0]) for r in f.candidate.source_refs]
        assert refs == sorted(refs), f"{f.candidate.label}: {f.candidate.source_refs}"
        assert len(refs) == len(set(f.candidate.source_refs))


def test_single_value_breakdowns_add_no_findings() -> None:
    a = fixture("valid_long_format.csv")  # one account, one region
    assert {f.candidate.dimension for f in a.findings} == {"service"}


def test_account_breakdown_with_several_accounts_is_used() -> None:
    lines = ["Date,Service,Linked account,Cost,Currency"]
    for month, prod, dev in (("2026-06-01", "5000", "1000"), ("2026-07-01", "5100", "3000")):
        lines += [f"{month},EC2,111111111111,{prod},USD", f"{month},EC2,222222222222,{dev},USD"]
    a = run(("\n".join(lines) + "\n").encode())
    acct = [f for f in a.findings if f.candidate.dimension == "account"]
    assert [f.candidate.label for f in acct] == ["222222222222"]
    assert acct[0].packet["finding"]["label"] == "acct_02"


# ---------------------------------------------------------------- packet ---


def test_packet_is_minimized() -> None:
    lines = ["Date,Service,Linked account,Cost,Currency"]
    for month, a_cost, b_cost in (("2026-06-01", "5000", "1000"), ("2026-07-01", "5100", "3000")):
        lines += [f"{month},EC2,123456789012,{a_cost},USD", f"{month},EC2,210987654321,{b_cost},USD"]
    a = run(("\n".join(lines) + "\n").encode())
    for f in a.findings:
        blob = canonical_json(f.packet).decode()
        assert not re.search(r"\d{12}", blob.replace(f.candidate.evidence_id, ""))
        assert "@" not in blob
        # Rule outcomes are not given to the model, so its answers are independent.
        for key in ("material", "severity", "default_category", "category"):
            assert f'"{key}"' not in blob


def test_instruction_like_and_formula_labels_are_withheld() -> None:
    a = fixture("prompt_injection_labels.csv")
    labels = {f.packet["finding"]["label"] for f in a.findings}
    assert all(not re.search(r"ignore|instruction|=|http", lbl, re.I) for lbl in labels)
    assert any(f.packet["finding"]["label_withheld"] for f in a.findings)


def test_packet_hash_is_stable_and_sensitive() -> None:
    a1, a2 = fixture("valid_cost_explorer.csv"), fixture("valid_cost_explorer.csv")
    assert [f.packet_sha256 for f in a1.findings] == [f.packet_sha256 for f in a2.findings]
    assert a1.packets_sha256 == a2.packets_sha256
    p = json.loads(canonical_json(a1.findings[0].packet))
    p["finding"]["current_cost"] = "1840.01"
    assert packet_sha256(p) != a1.findings[0].packet_sha256


def test_analysis_is_deterministic() -> None:
    a1, a2 = fixture("valid_long_format.csv"), fixture("valid_long_format.csv")
    assert a1.summary == a2.summary
    assert [(f.candidate, f.card) for f in a1.findings] == [(f.candidate, f.card) for f in a2.findings]


# ---------------------------------------------------------- explanations ---


@pytest.mark.parametrize("name", [*sorted(p.name for p in FIXTURES.glob("valid_*.csv")), "partial_period.csv"])
def test_explanations_never_suggest_destructive_actions(name: str) -> None:
    for f in fixture(name).findings:
        text = " ".join([f.card.title, f.card.what_changed, f.card.next_action, *(s.text for s in f.card.what_we_know)])
        assert not PROHIBITED.search(text.replace(f.candidate.label, "")), text


def test_explanation_numbers_are_the_computed_facts() -> None:
    f = fixture("valid_cost_explorer.csv").findings[0]
    assert "$1,840.00" in f.card.what_changed and "20.2%" in f.card.what_changed
    assert f.card.next_action.startswith("Confirm which team owns this spend")
    assert f.card.source == "template"


def test_categories_are_limited_to_the_four_live_decisions() -> None:
    assert {c.value for c in Category} == {"INVESTIGATE", "REQUEST_EVIDENCE", "MONITOR", "ESCALATE"}


# ----------------------------------------------- multi-dimension exports ---


def test_one_movement_described_by_several_dimensions_is_reported_once() -> None:
    """In this export prod-main, us-east-1 and the Platform team are the same two rows. Reporting
    each as its own finding would make one increase look like three."""
    a = fixture("cur_camelcase.csv")
    labels = [f.candidate.label for f in a.findings]
    assert "Platform" in labels  # a team name is the most useful heading for those rows
    assert "prod-main" not in labels and "us-east-1" not in labels
    assert len(labels) == len(set(labels))


def test_the_teaser_figure_never_exceeds_the_whole_bill_increase() -> None:
    """Every row has one service, so service increases add up to at most the bill's increase. The
    account, region and tag views of the same rows must not be added on top."""
    a = fixture("cur_camelcase.csv")
    impact = Decimal(a.summary["investigation_impact"])
    whole_bill = Decimal(a.summary["comparison"]["delta"])
    assert whole_bill == Decimal("3200.00")
    assert Decimal(0) <= impact <= whole_bill
    services = sum(
        (f.candidate.delta for f in a.findings
         if f.candidate.material and f.candidate.dimension == "service" and f.candidate.delta > 0),
        Decimal(0),
    )
    assert impact == min(services, whole_bill)


def test_a_partial_current_month_is_not_compared() -> None:
    a = fixture("cur_partial_month.csv")
    assert a.abstained is True
    assert a.summary["comparison"] is None
    assert Decimal(a.summary["investigation_impact"]) == Decimal(0)
