# Brief for generating the test corpus

The prompt below is written to be handed to a research-capable LLM. It exists because the first
synthetic corpus scaled cost without scaling usage, so every "scenario" in it was really the same
event — a uniform unit-price rise — and none of the ten described scenarios were present in the data
(see `docs/positioning.md` §7). This brief fixes that and adds the realism our parser and our copy
now need.

Two things this brief deliberately insists on, because they are where the last corpus failed:

1. **Cost must be derived from quantity × rate, never asserted independently.** The scenario has to
   be visible in *which of the two moved*.
2. **Unit prices must be real.** The old corpus billed Fargate at about $0.31 per vCPU-hour, roughly
   seven times AWS list. A FinOps reader would distrust the report on sight, and any reasoning we
   build about rates would be validated against fiction.

---

## The prompt

> **Task.** Generate a synthetic corpus of AWS billing exports for testing a product that turns a
> customer's billing export into a decision report. Research first, then write a seeded generator
> script, then produce the files. Everything must be invented — no real customer data — but it must
> be *structurally and economically indistinguishable* from what a real company would upload.
>
> ### Part 0 — Research before you generate, and cite your sources
>
> 1. **The exact CSV that AWS Cost Explorer's "Download as CSV" produces today.** Confirm: whether
>    the group-by dimension is the first column header and the periods are rows (or transposed), the
>    `($)` currency suffix on value headers, the `Total costs($)` column, the `<Dimension> total`
>    row, the date format, quoting rules, and how the output differs for daily vs monthly
>    granularity and when grouping by Linked Account, Usage Type, Region, or a cost-allocation tag
>    (including how untagged spend is labelled — e.g. `No tag key: team`, `Others`).
> 2. **Cost and Usage Report / AWS Data Exports column names**, both the full CUR 2.0 naming
>    (`lineItem/UsageStartDate`, `lineItem/UnblendedCost`, `lineItem/UsageAmount`,
>    `product/ProductName`, `lineItem/UsageType`, `lineItem/Operation`, `lineItem/ResourceId`,
>    `lineItem/LineItemType`, `resourceTags/user:Team`, …) and the flattened CamelCase names that
>    appear when someone exports a filtered query from Athena or a BI tool. Confirm the
>    `lineItem/LineItemType` vocabulary (Usage, Tax, Credit, Refund, DiscountedUsage, RIFee,
>    SavingsPlanCoveredUsage, SavingsPlanNegation, …).
> 3. **Current AWS list prices**, us-east-1 unless stated, for every usage type you use. Cite the
>    pricing page for each. At minimum: Fargate vCPU-hour and GB-hour; S3 Standard GB-month; data
>    transfer out to internet per GB (note the tiering and free allowance); NAT gateway per hour and
>    per GB processed; EBS gp3 GB-month; on-demand hourly for each EC2 family you use; GPU instances
>    (p4d, p5, g5); RDS instance-hours; Athena per TB scanned; Glue DPU-hour; CloudFront per GB;
>    Bedrock per 1K tokens; SageMaker instance-hours.
> 4. **The shape of a real small-to-mid company's AWS bill**: how concentrated it is (top three
>    services as a share of total), typical cost-allocation tag coverage, and how Tax, Support,
>    credits and Savings Plan lines appear.
>
> ### Part 1 — The customer whose files these mimic
>
> A 20–200 person engineering organisation, **$5,000–$150,000 a month** on AWS, one to four linked
> accounts, no dedicated FinOps function. Tag coverage is **partial and uneven — 30–70% of spend**,
> because tagging was applied to newer workloads only. Three or four services carry 60–80% of the
> bill. Tax and Support lines are present. Credits appear occasionally. The person exporting the
> file is a platform or infrastructure lead doing it by hand, once, in the console — so exports are
> usually **two to four months**, often include the **current month to date**, and are whatever the
> console gave them.
>
> ### Part 2 — The invariant the previous corpus broke
>
> **Cost must be computed as `quantity × unit_rate`, rounded to cents — never assigned
> independently.** Each scenario must be expressed in *which factor moved*:
>
> | Scenario type | quantity | unit rate |
> |---|---|---|
> | Volume growth (more traffic, more workloads) | rises | flat (±1% noise) |
> | Rate event (expired Savings Plan or RI, lost credit, region or family change) | flat (±2%) | rises |
> | Mixed | both move | both move |
> | New workload | 0 → positive | plausible for the usage type |
> | Efficiency win | falls | flat |
>
> The previous corpus multiplied every cost in a file by a constant (for example +55.0% on all seven
> services) while leaving quantity flat. Every file therefore described the same event — a uniform
> price rise — regardless of the scenario it claimed. **Do not do this.** Different services in the
> same file must move for different reasons and by different amounts, with only the named scenario
> dominating.
>
> Unit rates must be within ~10% of the researched list price unless the scenario is explicitly about
> a rate change (expired commitment, on-demand fallback, cross-region), in which case the change must
> be **explainable and bounded** — e.g. a Savings Plan expiring takes a rate from the discounted
> level to on-demand, roughly +30–40%, not an arbitrary multiplier.
>
> ### Part 3 — Scenarios to generate (12–14 files)
>
> Each must be *provable from the data itself*, not just asserted in a manifest.
>
> 1. **Steady growth, nothing material.** Volume +8–12% across a few services. Correct answer: no
>    finding worth a decision.
> 2. **Volume-driven surge in one service.** e.g. Fargate vCPU-hours +70%, rate flat.
> 3. **Rate event, single service.** A Savings Plan or RI expires on EC2: instance-hours flat, rate
>    steps from discounted to on-demand.
> 4. **Rate event, whole bill.** A credit stops applying. This is the one the old corpus produced by
>    accident — keep it, but label it correctly.
> 5. **Egress shock.** Data-transfer-out GB rises sharply, per-GB rate flat; CloudFront moves with
>    it. Compute flat.
> 6. **NAT gateway anomaly.** NAT processed-GB up several hundred percent while EC2 compute-hours
>    are flat — the misconfiguration signature.
> 7. **New workload appears.** A service with no history arrives mid-period with plausible quantities.
> 8. **GPU inference growth.** GPU instance-hours rise; also include a *second* month where hours are
>    flat but the mix shifts from spot to on-demand (a rate effect) — these must be distinguishable.
> 9. **Multi-account, multi-region expansion.** A new account and region appear; existing ones flat.
> 10. **Allocation gap.** 40–60% of spend has no team tag; the untagged share grows.
> 11. **Partial current month.** The export includes the month to date, ending mid-month. The correct
>     behaviour is to refuse to compare it.
> 12. **Credits, refunds, tax and Support** present as their own line-item types, including at least
>     one negative amount and one month where a credit expires.
> 13. **Efficiency win.** Something genuinely falls: quantity down, rate flat. (Almost no test corpus
>     has this, and reports that only ever see increases are never tested on the good news.)
> 14. **Messy but valid.** See Part 4.
>
> ### Part 4 — Formats and realistic mess
>
> Match how these files actually arrive:
>
> - **~60% Cost Explorer console exports** (the wide layout: one group-by dimension, periods as rows,
>   `($)` suffixes, a total row and column). Vary the group-by across Service, Linked Account, Usage
>   Type and a tag. **A Cost Explorer export carries one metric only** — the console's Metric
>   selector chooses between unblended cost, amortized cost, usage quantity and others, so a cost
>   export contains no quantities. Verify this in your research, and include **one paired case**: the
>   same period exported twice, once as cost and once as usage quantity, as a customer would have to
>   do to give us both. Name the pair so it is obviously a pair.
> - **~30% CUR-derived flat CSVs** with the CamelCase or `lineItem/` column names, including
>   `UsageQuantity`, `UsageUnit`, `Operation`, `ResourceId`, `LineItemType`, `Environment` and
>   `Application` columns.
> - **~10% third-party or hand-edited exports**: a file someone opened in Excel (UTF-8 BOM, CRLF), a
>   European locale export (semicolon delimiter, decimal comma), a file with an extra title row above
>   the header, and one with a manually appended total row that does not reconcile.
>
> Use **real AWS service names exactly as AWS writes them** ("Amazon Elastic Compute Cloud - Compute",
> "EC2 - Other", "Amazon Simple Storage Service", "AWS Data Transfer", "AmazonCloudWatch", "Tax",
> "AWS Support (Business)", "Savings Plans for AWS Compute usage") and real usage-type codes
> ("BoxUsage:m6i.large", "USE1-EBS:VolumeUsage.gp3", "USE1-DataTransfer-Out-Bytes",
> "USE1-NatGateway-Bytes", "Fargate-vCPU-Hours-perCPU"). **Do not adapt column names or values to any
> parser** — the point is to test against reality.
>
> Quantities must be plausible for their unit: GB-months in the thousands for a small S3 estate,
> instance-hours near 730 per instance-month, request counts in the millions.
>
> ### Part 5 — Deliverables
>
> 1. A **seeded, deterministic generator script** (Python, standard library only) that regenerates
>    every file byte-identically. The scenario definitions must be data at the top of the file, so a
>    reviewer can read the intent in one screen.
> 2. The generated CSVs.
> 3. A `manifest.csv` with, per file: the scenario name, the export format, the months covered, the
>    period totals, and — this is what the last manifest lacked — the **ground truth of the
>    decomposition** for each intended finding: `service`, `quantity_baseline`, `quantity_current`,
>    `rate_baseline`, `rate_current`, `volume_effect`, `rate_effect`, and the single sentence a
>    correct report should produce.
> 4. A short `README.md` stating that everything is synthetic, what each file is for, and the list
>    prices used with their sources and the date they were checked.
>
> ### Part 5b — What good output looks like
>
> A Cost Explorer console export, grouped by Service, three months (cost metric — note there are no
> quantities, which is exactly the limitation to represent):
>
> ```
> Service,Amazon Elastic Compute Cloud - Compute($),Amazon Relational Database Service($),Amazon Simple Storage Service($),AWS Data Transfer($),Tax($),Total costs($)
> Service total,18432.00,5256.00,1656.00,2700.00,2804.40,30848.40
> 2026-05-01,5616.00,1752.00,529.00,810.00,871.40,9578.40
> 2026-06-01,6144.00,1752.00,552.00,900.00,934.80,10282.80
> 2026-07-01,6672.00,1752.00,575.00,990.00,998.20,10987.20
> ```
>
> A CUR-derived flat export, where the scenario is visible in the numbers. Here a Savings Plan lapses:
> hours are flat, the rate steps from the discounted level to on-demand, and cost is the product of
> the two to the cent:
>
> ```
> TimePeriodStart,TimePeriodEnd,LinkedAccountId,LinkedAccountName,Region,Service,UsageType,Operation,ResourceId,UsageQuantity,UsageUnit,UnblendedCost,Currency,LineItemType,Environment,Team
> 2026-05-01,2026-05-31,123456789012,prod-platform,us-east-1,Amazon Elastic Container Service,Fargate-vCPU-Hours-perCPU,FargateTask,arn:aws:ecs:us-east-1:123456789012:service/api,17550.17,vCPU-Hours,710.43,USD,Usage,production,platform
> 2026-06-01,2026-06-30,123456789012,prod-platform,us-east-1,Amazon Elastic Container Service,Fargate-vCPU-Hours-perCPU,FargateTask,arn:aws:ecs:us-east-1:123456789012:service/api,17612.40,vCPU-Hours,998.62,USD,Usage,production,platform
> ```
>
> 17,550.17 × $0.04048 = $710.43; 17,612.40 × $0.0567 = $998.62. Quantity moved 0.4%, the rate moved
> 40%, and a correct report must say "this is a rate change, not more usage" and point at commitment
> coverage rather than at utilization. The manifest row for this finding carries those six numbers so
> the assertion can be written against it.
>
> ### Part 6 — Validate before delivering
>
> The generator must assert all of these and fail loudly otherwise:
>
> - For every row, `abs(quantity * rate - cost) < 0.01`.
> - For every intended finding, `volume_effect + rate_effect` equals the cost change to the cent
>   (use `Δcost = Δqty × rate_baseline + Δrate × qty_current`).
> - For each scenario, the dominant effect is the one the scenario claims — a volume scenario must
>   have `volume_effect > 70%` of the change, a rate scenario `rate_effect > 70%`.
> - Within any file, the per-service rate changes are **not** all identical (that was the old bug);
>   assert the spread across services is greater than one percentage point unless the scenario is
>   explicitly the whole-bill rate event.
> - Every unit rate is within 10% of the researched list price, except where the scenario justifies
>   it, and each exception is listed in the README with its reason.
> - Every file parses as UTF-8, is under 25 MB, and its stated period totals equal the sum of its
>   rows.
>
> Report the validation output alongside the files.
