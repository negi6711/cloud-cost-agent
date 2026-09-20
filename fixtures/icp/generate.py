"""Generate the ICP corpus: exports shaped like the ones our customers actually upload.

    uv run python fixtures/icp/generate.py

Everything here is invented. What makes it different from a naive synthetic corpus is one rule:

    cost is never assigned. It is always quantity x unit rate, rounded to cents.

so a scenario is expressed in *which factor moved*. The first corpus we tested against scaled cost
and left quantity alone, which made every file the same event (a uniform price rise) whatever its
name claimed, and hid that our report was sending readers to investigate the wrong thing.

Unit rates are real AWS list prices for us-east-1, checked 2026-09-20; sources are in README.md.
Where a scenario needs an off-list rate (a commitment lapsing, spot capacity) the line says so and
the validator lets it through.

The scenario table below is the whole design: read it and you know what every file contains.
"""

from __future__ import annotations

import csv
import io
import random
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

HERE = Path(__file__).parent
SEED = 20260920

# --- list prices, us-east-1, checked 2026-09-20 (README.md cites each one) -------------------

RATE = {
    "fargate_vcpu_hour": Decimal("0.04048"),
    "fargate_gb_hour": Decimal("0.004446"),
    "m6i_large_hour": Decimal("0.0960"),
    "m6i_8xlarge_hour": Decimal("1.5360"),  # 16x m6i.large, same family
    "g5_12xlarge_hour": Decimal("5.6720"),
    "g5_12xlarge_spot": Decimal("2.0419"),  # ~36% of on-demand; varies, see README
    "db_r6g_large_hour": Decimal("0.2600"),
    "s3_standard_gb_month": Decimal("0.023"),
    "ebs_gp3_gb_month": Decimal("0.08"),
    "data_transfer_out_gb": Decimal("0.09"),
    "cloudfront_out_gb": Decimal("0.085"),
    "nat_gateway_gb": Decimal("0.045"),
    "nat_gateway_hour": Decimal("0.045"),
    "athena_tb_scanned": Decimal("5.00"),
    "glue_dpu_hour": Decimal("0.44"),
    "cloudwatch_gb_ingest": Decimal("0.50"),
}

SP_DISCOUNT = Decimal("0.72")  # a 1-year no-upfront Compute Savings Plan, ~28% off on-demand

CENT = Decimal("0.01")
ONE = Decimal("1")


def money(d: Decimal) -> Decimal:
    return d.quantize(CENT, rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class Line:
    """One usage line: what it is, how much of it, and at what price, month by month.

    `qty` and `rate` are the baseline (first month). `qty_factors` and `rate_factors` multiply the
    baseline for each month, so the scenario is legible as two rows of numbers.
    """

    service: str
    usage_type: str
    unit: str
    rate: Decimal
    qty: Decimal
    qty_factors: tuple[str, ...] = ("1", "1", "1")
    rate_factors: tuple[str, ...] = ("1", "1", "1")
    account: str = "prod-platform"
    account_id: str = "123456789012"
    region: str = "us-east-1"
    team: str = "platform"
    environment: str = "production"
    operation: str = "RunInstances"
    resource: str = "resource/main"
    item_type: str = "Usage"
    off_list: str = ""  # reason this rate is not a list price; empty means it must match

    def month(self, i: int, rng: random.Random) -> tuple[Decimal, Decimal, Decimal]:
        """(quantity, rate, cost) for month i, with a little noise on quantity only."""
        qty = self.qty * Decimal(self.qty_factors[i])
        if i and self.qty_factors[i] == self.qty_factors[i - 1]:
            qty *= ONE + Decimal(str(round(rng.uniform(-0.012, 0.012), 5)))  # real usage wobbles
        rate = self.rate * Decimal(self.rate_factors[i])
        qty = qty.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        rate = rate.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
        return qty, rate, money(qty * rate)


@dataclass(frozen=True)
class Scenario:
    name: str
    layout: str  # "ce" (Cost Explorer wide) | "cur" (flat, with quantities)
    months: tuple[str, ...]
    lines: tuple[Line, ...]
    story: str
    effect: str  # "volume" | "rate" | "mixed" | "new" | "none" | "allocation" | "partial"
    watch: str = ""  # the service the scenario is about, for the manifest ground truth
    group_by: str = "Service"
    uniform: bool = False  # every service moves by the same cost percentage, on purpose
    currency: str = "USD"
    note: str = ""
    extras: dict[str, str] = field(default_factory=dict)


def _line(**defaults: object):
    def make(**kw: object) -> Line:
        return Line(**{**defaults, **kw})  # type: ignore[arg-type]
    return make


ec2 = _line(service="Amazon Elastic Compute Cloud - Compute", usage_type="BoxUsage:m6i.large",
            unit="Hrs", rate=RATE["m6i_large_hour"], qty=Decimal("43800"), resource="asg/api")
s3 = _line(service="Amazon Simple Storage Service", usage_type="TimedStorage-ByteHrs",
           unit="GB-Mo", rate=RATE["s3_standard_gb_month"], qty=Decimal("23000"),
           operation="StandardStorage", resource="bucket/app-assets")
rds = _line(service="Amazon Relational Database Service", usage_type="InstanceUsage:db.r6g.large",
            unit="Hrs", rate=RATE["db_r6g_large_hour"], qty=Decimal("2190"),
            operation="CreateDBInstance", team="data", resource="db/primary")
transfer = _line(service="AWS Data Transfer", usage_type="USE1-DataTransfer-Out-Bytes", unit="GB",
                 rate=RATE["data_transfer_out_gb"], qty=Decimal("9000"), operation="PublicIP-Out",
                 resource="dt/internet")
tax = _line(service="Tax", usage_type="Tax", unit="Each", rate=Decimal("1"), qty=Decimal("980"),
            operation="Tax", item_type="Tax", team="", environment="", resource="",
            off_list="tax is a charge, not a metered rate")


FLAT = ("1", "1", "1")


SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        name="01_steady_growth_ce",
        layout="ce", months=("2026-05-01", "2026-06-01", "2026-07-01"), effect="none",
        story="Ordinary growth. Usage rises 8-12% across a few services, rates flat. Nothing here "
              "deserves a decision.",
        lines=(
            ec2(qty_factors=("1", "1.09", "1.18")),
            s3(qty_factors=("1", "1.06", "1.11")),
            rds(qty_factors=FLAT),
            transfer(qty_factors=("1", "1.11", "1.20")),
            tax(qty_factors=("1", "1.08", "1.16")),
        ),
    ),
    Scenario(
        name="02_fargate_volume_surge_cur",
        layout="cur", months=("2026-05-01", "2026-06-01"), effect="volume",
        watch="Amazon Elastic Container Service",
        story="Container workload genuinely grew: Fargate vCPU-hours up 70% at an unchanged rate. "
              "The right question is what was deployed, and whether the traffic justifies it.",
        lines=(
            Line(service="Amazon Elastic Container Service", usage_type="Fargate-vCPU-Hours-perCPU",
                 unit="vCPU-Hours", rate=RATE["fargate_vcpu_hour"], qty=Decimal("17550.17"),
                 qty_factors=("1", "1.70"), operation="FargateTask", resource="service/api"),
            Line(service="Amazon Elastic Container Service", usage_type="Fargate-GB-Hours",
                 unit="GB-Hours", rate=RATE["fargate_gb_hour"], qty=Decimal("35100.34"),
                 qty_factors=("1", "1.70"), operation="FargateTask", resource="service/api"),
            ec2(qty_factors=("1", "1.01")), s3(qty_factors=("1", "1.02")), rds(),
            transfer(qty_factors=("1", "1.12")),
        ),
    ),
    Scenario(
        name="03_savings_plan_lapse_cur",
        layout="cur", months=("2026-05-01", "2026-06-01"), effect="rate",
        watch="Amazon Elastic Compute Cloud - Compute",
        story="A one-year Compute Savings Plan expired. EC2 instance-hours are flat; the effective "
              "rate steps from the covered price back to on-demand. Nobody deployed anything.",
        lines=(
            Line(service="Amazon Elastic Compute Cloud - Compute", usage_type="BoxUsage:m6i.8xlarge",
                 unit="Hrs", rate=RATE["m6i_8xlarge_hour"] * SP_DISCOUNT, qty=Decimal("5840"),
                 rate_factors=("1", str(ONE / SP_DISCOUNT)),
                 off_list="covered by a Compute Savings Plan until it lapsed", resource="asg/api"),
            s3(qty_factors=("1", "1.03")), rds(), transfer(qty_factors=("1", "1.02")),
        ),
    ),
    Scenario(
        name="04_credit_expiry_cur",
        layout="cur", months=("2026-05-01", "2026-06-01"), effect="rate", uniform=True,
        watch="Amazon Elastic Compute Cloud - Compute",
        story="A promotional credit stopped applying. Usage is unchanged everywhere; the whole bill "
              "steps up because the offsetting credit line disappears.",
        lines=(
            ec2(qty_factors=("1", "1.01")), s3(), rds(), transfer(qty_factors=("1", "1.01")),
            Line(service="Amazon Elastic Compute Cloud - Compute", usage_type="Credit",
                 unit="Each", rate=Decimal("-1200"), qty=Decimal("1"), qty_factors=("1", "0"),
                 item_type="Credit", operation="Credit", resource="",
                 off_list="a credit is a fixed offset, not a metered rate"),
        ),
    ),
    Scenario(
        name="05_egress_shock_cur",
        layout="cur", months=("2026-05-01", "2026-06-01"), effect="volume",
        watch="AWS Data Transfer",
        story="Egress volume quadrupled at an unchanged per-GB rate, and CloudFront moved with it. "
              "Compute is flat, so this is a traffic or payload change, not a deployment.",
        lines=(
            transfer(qty_factors=("1", "4.10")),
            Line(service="Amazon CloudFront", usage_type="US-DataTransfer-Out-Bytes", unit="GB",
                 rate=RATE["cloudfront_out_gb"], qty=Decimal("4200"), qty_factors=("1", "3.40"),
                 operation="GET", team="application", resource="distribution/web"),
            ec2(qty_factors=("1", "1.02")), s3(qty_factors=("1", "1.04")), rds(),
        ),
    ),
    Scenario(
        name="06_nat_gateway_anomaly_cur",
        layout="cur", months=("2026-04-01", "2026-05-01"), effect="volume",
        watch="Amazon Virtual Private Cloud",
        story="NAT gateway processed-GB up fivefold while EC2 compute-hours are flat: the signature "
              "of traffic routed through NAT that should not be, not of a bigger workload.",
        lines=(
            Line(service="Amazon Virtual Private Cloud", usage_type="USE1-NatGateway-Bytes",
                 unit="GB", rate=RATE["nat_gateway_gb"], qty=Decimal("12000"),
                 qty_factors=("1", "5.20"), operation="NatGateway", resource="natgw/private-a"),
            Line(service="Amazon Virtual Private Cloud", usage_type="USE1-NatGateway-Hours",
                 unit="Hrs", rate=RATE["nat_gateway_hour"], qty=Decimal("2190"),
                 operation="NatGateway", resource="natgw/private-a"),
            ec2(qty_factors=("1", "1.01")), s3(qty_factors=("1", "1.02")), rds(),
            transfer(qty_factors=("1", "1.06")),
        ),
    ),
    Scenario(
        name="07_new_workload_ce",
        layout="ce", months=("2026-05-01", "2026-06-01", "2026-07-01"), effect="new",
        watch="Amazon Elastic Container Service",
        story="A container platform arrives in the last month with no history at all.",
        lines=(
            ec2(qty_factors=("1", "1.02", "1.03")), s3(qty_factors=("1", "1.02", "1.05")), rds(),
            transfer(qty_factors=("1", "1.05", "1.09")),
            Line(service="Amazon Elastic Container Service", usage_type="Fargate-vCPU-Hours-perCPU",
                 unit="vCPU-Hours", rate=RATE["fargate_vcpu_hour"], qty=Decimal("21400"),
                 qty_factors=("0", "0", "1"), operation="FargateTask", resource="service/api"),
        ),
    ),
    Scenario(
        name="08_gpu_hours_growth_cur",
        layout="cur", months=("2026-05-01", "2026-06-01"), effect="volume",
        watch="Amazon Elastic Compute Cloud - Compute",
        story="Inference demand grew: GPU instance-hours up 85% at the on-demand rate. Pairs with "
              "09, where the hours are flat and only the rate moves.",
        lines=(
            Line(service="Amazon Elastic Compute Cloud - Compute", usage_type="BoxUsage:g5.12xlarge",
                 unit="Hrs", rate=RATE["g5_12xlarge_hour"], qty=Decimal("1460"),
                 qty_factors=("1", "1.85"), team="ml-platform", environment="production",
                 resource="asg/inference"),
            Line(service="Amazon Elastic Block Store", usage_type="USE1-EBS:VolumeUsage.gp3",
                 unit="GB-Mo", rate=RATE["ebs_gp3_gb_month"], qty=Decimal("18000"),
                 qty_factors=("1", "1.40"), team="ml-platform", operation="CreateVolume",
                 resource="volume/inference"),
            s3(qty_factors=("1", "1.09")), transfer(qty_factors=("1", "1.15")),
        ),
    ),
    Scenario(
        name="09_gpu_spot_to_ondemand_cur",
        layout="cur", months=("2026-05-01", "2026-06-01"), effect="rate",
        watch="Amazon Elastic Compute Cloud - Compute",
        story="The same GPU hours as last month, but spot capacity was interrupted and the fleet "
              "fell back to on-demand. Hours flat, effective rate up 2.8x.",
        lines=(
            Line(service="Amazon Elastic Compute Cloud - Compute", usage_type="SpotUsage:g5.12xlarge",
                 unit="Hrs", rate=RATE["g5_12xlarge_spot"], qty=Decimal("2700"),
                 rate_factors=("1", str(RATE["g5_12xlarge_hour"] / RATE["g5_12xlarge_spot"])),
                 off_list="spot capacity, then on-demand fallback", team="ml-platform",
                 resource="asg/inference"),
            Line(service="Amazon Elastic Block Store", usage_type="USE1-EBS:VolumeUsage.gp3",
                 unit="GB-Mo", rate=RATE["ebs_gp3_gb_month"], qty=Decimal("25000"),
                 qty_factors=("1", "1.02"), team="ml-platform", operation="CreateVolume",
                 resource="volume/inference"),
            s3(qty_factors=("1", "1.03")), transfer(qty_factors=("1", "1.04")),
        ),
    ),
    Scenario(
        name="10_allocation_gap_ce_by_tag",
        layout="ce", months=("2026-05-01", "2026-06-01"), effect="allocation", group_by="Tag: team",
        story="Grouped by the team tag. Untagged spend is already half the bill and grows faster "
              "than anything tagged, so most of the increase cannot be attributed to anyone.",
        lines=(
            Line(service="platform", usage_type="-", unit="Hrs", rate=RATE["m6i_large_hour"],
                 qty=Decimal("43800"), qty_factors=("1", "1.04")),
            Line(service="data", usage_type="-", unit="Hrs", rate=RATE["db_r6g_large_hour"],
                 qty=Decimal("4380"), qty_factors=("1", "1.06")),
            Line(service="No tag key: team", usage_type="-", unit="Hrs",
                 rate=RATE["m6i_8xlarge_hour"], qty=Decimal("2920"), qty_factors=("1", "1.55"),
                 off_list="a tag bucket aggregates many rates"),
        ),
    ),
    Scenario(
        name="11_partial_current_month_ce",
        layout="ce", months=("2026-06-01", "2026-07-01", "2026-08-01"), effect="partial",
        story="Exported on the 18th, so the last month is 18 days of 31. A correct report refuses "
              "to compare it and says why.",
        lines=(
            ec2(qty_factors=("1", "1.03", "0.58")), s3(qty_factors=("1", "1.02", "0.58")),
            rds(qty_factors=("1", "1", "0.58")), transfer(qty_factors=("1", "1.07", "0.58")),
        ),
        note="the final month covers 2026-08-01 to 2026-08-18",
    ),
    Scenario(
        name="12_efficiency_win_cur",
        layout="cur", months=("2026-05-01", "2026-06-01"), effect="volume",
        watch="Amazon Simple Storage Service",
        story="Someone deleted old data and set a lifecycle policy: S3 GB-months down 34% at an "
              "unchanged rate. A report that only ever finds increases never gets tested on this.",
        lines=(
            s3(qty=Decimal("140000"), qty_factors=("1", "0.66")),
            ec2(qty_factors=("1", "1.01")), rds(), transfer(qty_factors=("1", "0.97")),
        ),
    ),
    Scenario(
        name="13_multi_account_expansion_cur",
        layout="cur", months=("2026-05-01", "2026-06-01"), effect="new",
        watch="Amazon Elastic Compute Cloud - Compute",
        story="A second account in eu-west-1 appears for an EU launch. Existing accounts are flat, "
              "so the whole increase sits in the new one.",
        lines=(
            ec2(qty_factors=("1", "1.02")), s3(qty_factors=("1", "1.03")), rds(),
            Line(service="Amazon Elastic Compute Cloud - Compute", usage_type="EUW1-BoxUsage:m6i.large",
                 unit="Hrs", rate=RATE["m6i_large_hour"] * Decimal("1.08"), qty=Decimal("14600"),
                 qty_factors=("0", "1"), account="prod-eu", account_id="210987654321",
                 region="eu-west-1", off_list="eu-west-1 list price differs from us-east-1",
                 resource="asg/eu-api"),
            Line(service="Amazon Simple Storage Service", usage_type="EUW1-TimedStorage-ByteHrs",
                 unit="GB-Mo", rate=RATE["s3_standard_gb_month"] * Decimal("1.04"),
                 qty=Decimal("8000"), qty_factors=("0", "1"), account="prod-eu",
                 account_id="210987654321", region="eu-west-1", operation="StandardStorage",
                 off_list="eu-west-1 list price differs from us-east-1", resource="bucket/eu"),
        ),
    ),
    Scenario(
        name="14_messy_excel_ce",
        layout="ce", months=("2026-05-01", "2026-06-01"), effect="volume",
        story="Opened in Excel and saved again: byte-order mark, CRLF line endings, a title row "
              "above the header, and a total row someone edited so it no longer reconciles.",
        lines=(ec2(qty_factors=("1", "1.22")), s3(qty_factors=("1", "1.05")), rds()),
        extras={"bom": "1", "crlf": "1", "title_row": "1", "break_total": "1"},
    ),
    Scenario(
        name="15_eu_locale_ce",
        layout="ce", months=("2026-05-01", "2026-06-01"), effect="volume", currency="EUR",
        story="A European console export: semicolon delimiter, decimal comma, euro marker.",
        lines=(ec2(qty_factors=("1", "1.18")), s3(qty_factors=("1", "1.03")), rds()),
        extras={"delimiter": ";", "decimal_comma": "1"},
    ),
    Scenario(
        name="16a_paired_cost_ce",
        layout="ce", months=("2026-05-01", "2026-06-01"), effect="rate",
        watch="Amazon Elastic Compute Cloud - Compute",
        story="Half of a pair. A Cost Explorer export carries one metric, so this cost export has no "
              "quantities: on its own it cannot say whether usage or price moved.",
        lines=(
            Line(service="Amazon Elastic Compute Cloud - Compute", usage_type="BoxUsage:m6i.8xlarge",
                 unit="Hrs", rate=RATE["m6i_8xlarge_hour"] * SP_DISCOUNT, qty=Decimal("5840"),
                 rate_factors=("1", str(ONE / SP_DISCOUNT)),
                 off_list="covered by a Compute Savings Plan until it lapsed"),
            s3(qty_factors=("1", "1.02")), rds(),
        ),
    ),
    Scenario(
        name="16b_paired_usage_ce",
        layout="ce", months=("2026-05-01", "2026-06-01"), effect="rate", extras={"metric": "usage"},
        watch="Amazon Elastic Compute Cloud - Compute",
        story="The other half: the same view re-exported with the Usage quantity metric. Together "
              "with 16a it shows hours flat while cost rose. Alone it is quantities with no "
              "currency, which a reader could mistake for money.",
        lines=(
            Line(service="Amazon Elastic Compute Cloud - Compute", usage_type="BoxUsage:m6i.8xlarge",
                 unit="Hrs", rate=RATE["m6i_8xlarge_hour"] * SP_DISCOUNT, qty=Decimal("5840"),
                 rate_factors=("1", str(ONE / SP_DISCOUNT)),
                 off_list="covered by a Compute Savings Plan until it lapsed"),
            s3(qty_factors=("1", "1.02")), rds(),
        ),
    ),
)

CUR_HEADER = ("TimePeriodStart", "TimePeriodEnd", "LinkedAccountId", "LinkedAccountName", "Region",
              "Service", "UsageType", "Operation", "ResourceId", "UsageQuantity", "UsageUnit",
              "UnblendedCost", "Currency", "LineItemType", "Environment", "Team")


def month_end(month: str, partial_to: int | None = None) -> str:
    y, m, _ = (int(p) for p in month.split("-"))
    if partial_to:
        return f"{y:04d}-{m:02d}-{partial_to:02d}"
    last = [31, 29 if y % 4 == 0 and (y % 100 or y % 400 == 0) else 28,
            31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return f"{y:04d}-{m:02d}-{last:02d}"


def compute(s: Scenario) -> list[list[tuple[Line, Decimal, Decimal, Decimal]]]:
    """Per month, the (line, quantity, rate, cost) tuples. One rng per scenario keeps it seeded."""
    rng = random.Random(f"{SEED}:{s.name}")  # noqa: S311 - test data, not cryptography
    return [[(line, *line.month(i, rng)) for line in s.lines] for i in range(len(s.months))]


def render_cur(s: Scenario, per_month: list[list[tuple[Line, Decimal, Decimal, Decimal]]]) -> str:
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(CUR_HEADER)
    for i, month in enumerate(s.months):
        for line, qty, _rate, cost in per_month[i]:
            if qty == 0:
                continue  # a workload that does not exist yet has no rows, it is not a zero row
            w.writerow([month, month_end(month), line.account_id, line.account, line.region,
                        line.service, line.usage_type, line.operation,
                        f"arn:aws:{line.region}:{line.account_id}:{line.resource}" if line.resource else "",
                        qty, line.unit, cost, s.currency, line.item_type, line.environment, line.team])
    return out.getvalue()


def render_ce(s: Scenario, per_month: list[list[tuple[Line, Decimal, Decimal, Decimal]]]) -> str:
    """Cost Explorer's own shape: the group-by down the columns, one row per period."""
    usage_metric = s.extras.get("metric") == "usage"
    groups: list[str] = []
    for row in per_month:
        for line, *_ in row:
            if line.service not in groups:
                groups.append(line.service)

    def value(i: int, group: str) -> Decimal:
        total = Decimal(0)
        for line, qty, _rate, cost in per_month[i]:
            if line.service == group:
                total += qty if usage_metric else cost
        return total.quantize(CENT, rounding=ROUND_HALF_UP)

    marker = "" if usage_metric else {"USD": "($)", "EUR": "(€)"}[s.currency]
    header = [s.group_by, *(f"{g}{marker}" for g in groups),
              f"Total usage{marker}" if usage_metric else f"Total costs{marker}"]
    totals = [sum((value(i, g) for i in range(len(s.months))), Decimal(0)) for g in groups]
    rows: list[list[object]] = [[f"{s.group_by} total", *totals, sum(totals, Decimal(0))]]
    for i, month in enumerate(s.months):
        vals = [value(i, g) for g in groups]
        rows.append([month, *vals, sum(vals, Decimal(0))])
    if s.extras.get("break_total"):
        rows[0][1] = (Decimal(rows[0][1]) * Decimal("1.4")).quantize(CENT)  # someone edited it

    decimal_comma = s.extras.get("decimal_comma")
    delimiter = s.extras.get("delimiter", ",")
    out = io.StringIO()
    w = csv.writer(out, delimiter=delimiter, lineterminator="\r\n" if s.extras.get("crlf") else "\n")
    if s.extras.get("title_row"):
        w.writerow([f"Cost Explorer report, generated {s.months[-1]}"])
    w.writerow(header)
    for row in rows:
        w.writerow([str(c).replace(".", ",") if decimal_comma and not isinstance(c, str) else c
                    for c in row])
    return out.getvalue()


# ------------------------------------------------------------------ validation ---


def split(before: tuple[Decimal, Decimal], after: tuple[Decimal, Decimal]) -> tuple[Decimal, Decimal]:
    """(volume effect, rate effect) for a movement, which sum to the cost change."""
    (qb, rb), (qc, rc) = before, after
    return money((qc - qb) * rb), money((rc - rb) * qc)


def validate(s: Scenario, per_month: list[list[tuple[Line, Decimal, Decimal, Decimal]]]) -> list[str]:
    problems: list[str] = []
    for i, row in enumerate(per_month):
        for line, qty, rate, cost in row:
            if abs(qty * rate - cost) > CENT:
                problems.append(f"{s.name} {s.months[i]} {line.usage_type}: cost != qty x rate")
            if not line.off_list and rate > 0:
                nearest = min(RATE.values(), key=lambda r: abs(r - rate))
                if abs(rate - nearest) / nearest > Decimal("0.10"):
                    problems.append(f"{s.name} {line.usage_type}: rate {rate} is not a list price")

    if len(s.months) >= 2 and s.watch:
        b, c = per_month[0], per_month[-1]
        watched = [(x, y) for x, y in zip(b, c, strict=True) if x[0].service == s.watch]
        qb = sum((x[1] for x, _ in watched), Decimal(0))
        qc = sum((y[1] for _, y in watched), Decimal(0))
        cb = sum((x[3] for x, _ in watched), Decimal(0))
        cc = sum((y[3] for _, y in watched), Decimal(0))
        if qb and qc:
            vol, rat = split((qb, cb / qb), (qc, cc / qc))
            if abs((vol + rat) - (cc - cb)) > Decimal("0.50"):
                problems.append(f"{s.name}: effects {vol}+{rat} do not sum to {cc - cb}")
            dominant = abs(vol) / (abs(vol) + abs(rat)) if (vol or rat) else Decimal(0)
            if s.effect == "volume" and dominant < Decimal("0.70"):
                problems.append(f"{s.name}: claims volume but volume is only {dominant:.0%}")
            if s.effect == "rate" and dominant > Decimal("0.30"):
                problems.append(f"{s.name}: claims rate but volume is {dominant:.0%}")

    if len(s.months) >= 2 and not s.uniform and s.effect not in ("partial", "allocation"):
        changes = set()
        for x, y in zip(per_month[0], per_month[-1], strict=True):
            if x[3] > 0:
                changes.add(((y[3] - x[3]) / x[3] * 100).quantize(Decimal("0.1")))
        if len(changes) > 1 and max(changes) - min(changes) < Decimal("1.0"):
            problems.append(f"{s.name}: every line moved by the same percentage, the old bug")
    return problems


def manifest_rows(s: Scenario, per_month: list[list[tuple[Line, Decimal, Decimal, Decimal]]]) -> dict[str, object]:
    totals = [sum((c for *_, c in row), Decimal(0)) for row in per_month]
    row: dict[str, object] = {
        "filename": f"{s.name}.csv", "layout": s.layout, "effect": s.effect,
        "months": " ".join(s.months), "period_totals": "; ".join(f"{m}={t}" for m, t in zip(s.months, totals, strict=True)),
        "watch": s.watch, "story": s.story, "note": s.note,
        "quantity_baseline": "", "quantity_current": "", "rate_baseline": "", "rate_current": "",
        "volume_effect": "", "rate_effect": "", "expected_sentence": "",
    }
    if s.watch and len(s.months) >= 2:
        b = [(x, y) for x, y in zip(per_month[0], per_month[-1], strict=True) if x[0].service == s.watch]
        qb = sum((x[1] for x, _ in b), Decimal(0))
        qc = sum((y[1] for _, y in b), Decimal(0))
        cb = sum((x[3] for x, _ in b), Decimal(0))
        cc = sum((y[3] for _, y in b), Decimal(0))
        if qb and qc:
            rb, rc = cb / qb, cc / qc
            vol, rat = split((qb, rb), (qc, rc))
            row.update(quantity_baseline=qb, quantity_current=qc,
                       rate_baseline=rb.quantize(Decimal("0.000001")),
                       rate_current=rc.quantize(Decimal("0.000001")),
                       volume_effect=vol, rate_effect=rat,
                       expected_sentence=("this is a usage change" if abs(vol) > abs(rat)
                                          else "this is a rate change, not more usage"))
    return row


def main() -> None:
    HERE.mkdir(parents=True, exist_ok=True)
    problems: list[str] = []
    rows: list[dict[str, object]] = []
    for s in SCENARIOS:
        per_month = compute(s)
        problems += validate(s, per_month)
        text = render_cur(s, per_month) if s.layout == "cur" else render_ce(s, per_month)
        data = text.encode("utf-8")
        if s.extras.get("bom"):
            data = b"\xef\xbb\xbf" + data
        (HERE / f"{s.name}.csv").write_bytes(data)
        rows.append(manifest_rows(s, per_month))
        print(f"wrote {s.name}.csv ({len(data):,} bytes)")

    with (HERE / "manifest.csv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    if problems:
        print("\nVALIDATION FAILED")
        for p in problems:
            print(f"  {p}")
        raise SystemExit(1)
    print(f"\n{len(SCENARIOS)} files, validation passed")


if __name__ == "__main__":
    main()
