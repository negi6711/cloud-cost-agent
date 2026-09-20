# ICP corpus — exports shaped like the ones customers upload

Synthetic. No real customer billing data. Regenerate with:

    uv run python fixtures/icp/generate.py

This corpus exists because the previous one scaled cost while leaving usage quantity flat, so every
file described the same event — a uniform unit-price rise — whatever scenario its manifest claimed
(`docs/positioning.md` §7). Here, **cost is never assigned: it is quantity × unit rate, rounded to
cents**, and each scenario is expressed in *which factor moved*. `generate.py` asserts that before
it writes anything.

**Exported on 2026-08-18.** A month-to-date period can only be recognised relative to the date the
export was taken, so tools that read this corpus must be told that date:

    CCA_TODAY=2026-08-18 uv run python scripts/render_reports.py ../fixtures/icp

## Unit rates

us-east-1 list prices, checked 2026-09-20. Rates in the files are within 10% of these unless the
scenario needs otherwise, and `generate.py` fails if that is violated.

| Unit | Rate | Source |
|---|---|---|
| Fargate vCPU-hour | $0.04048 | [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/) ($0.000011244/vCPU-second) |
| Fargate GB-hour | $0.004446 | same page ($0.000001235/GB-second) |
| m6i.large hour | $0.0960 | [EC2 on-demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/) |
| m6i.8xlarge hour | $1.5360 | 16 × m6i.large, same family |
| S3 Standard GB-month | $0.023 | [S3 pricing](https://aws.amazon.com/s3/pricing/), first 50 TB |
| EBS gp3 GB-month | $0.08 | [EBS pricing](https://aws.amazon.com/ebs/pricing/) |
| Data transfer out, internet | $0.09/GB | first 10 TB after the 100 GB free allowance |
| CloudFront data out | $0.085/GB | first 10 TB |
| NAT gateway | $0.045/hour and $0.045/GB | [VPC pricing](https://aws.amazon.com/vpc/pricing/) |
| g5.12xlarge hour | $5.6720 | on-demand; **not independently verified, treat as approximate** |
| db.r6g.large hour | $0.2600 | RDS on-demand; **not independently verified, treat as approximate** |

Deliberate off-list rates, each declared in the generator and allowed by the validator:

- **Savings Plan coverage** (files 03, 16a): 0.72 × on-demand, a one-year no-upfront Compute Savings
  Plan, and the lapse returns the rate to on-demand.
- **Spot** (file 09): ~36% of on-demand, then fallback to on-demand. Real spot prices float.
- **eu-west-1** (file 13): +4% to +8% on us-east-1 list.
- **Tax and credits**: fixed charges, not metered rates.
- **Tag buckets** (file 10): a tag aggregates many rates, so no single list price applies.

## The files

| File | Layout | What is in the data | A correct report should |
|---|---|---|---|
| 01 steady growth | Cost Explorer | usage +8–12%, rates flat | find nothing worth a decision |
| 02 Fargate volume surge | CUR | vCPU-hours +70%, rate flat | say usage grew; ask what was deployed |
| 03 Savings Plan lapse | CUR | hours flat, rate +38.9% | say the **rate** moved; ask about commitment coverage |
| 04 credit expiry | CUR | usage flat, a credit line disappears | attribute the step to the credit, not to a workload |
| 05 egress shock | CUR | egress GB ×4.1 at a flat rate, CloudFront follows | ask about traffic and payload, not utilization |
| 06 NAT gateway anomaly | CUR | NAT GB ×5.2, EC2 hours flat | point at the network path |
| 07 new workload | Cost Explorer | a service appears with no history | flag it as new and ownerless |
| 08 GPU hours growth | CUR | GPU hours +85% at on-demand | say usage grew |
| 09 GPU spot → on-demand | CUR | same hours, rate ×2.8 | say the rate moved — pairs with 08 |
| 10 allocation gap | Cost Explorer, by tag | untagged is half the bill and growing | quantify what cannot be attributed |
| 11 partial current month | Cost Explorer | last month is 18 of 31 days | refuse to compare it |
| 12 efficiency win | CUR | S3 GB-months −34%, rate flat | **say something** — see findings below |
| 13 multi-account expansion | CUR | a new account and region appear | locate the increase in the new account |
| 14 messy Excel | Cost Explorer | BOM, CRLF, a title row, a broken total | parse it — see findings below |
| 15 EU locale | Cost Explorer | semicolons, decimal commas, € | parse it |
| 16a / 16b paired | Cost Explorer | the same view as cost, then as usage quantity | together: hours flat, cost up |

`manifest.csv` carries the ground truth per file, including `quantity_baseline`,
`quantity_current`, `rate_baseline`, `rate_current`, `volume_effect` and `rate_effect` for the
watched service, so assertions can be written against numbers rather than prose.

## What this corpus found on its first run

1. **A rate event is reported as a deployment.** File 03 (Savings Plan lapse: hours flat, rate
   +38.9%) produces "Ask platform what changed in June 2026 and collect CloudWatch utilization".
   Nobody changed anything and utilization is irrelevant. The same is true of 04 and 09. This is the
   reproducible case for reading `UsageQuantity`.
2. **A file with a title row above the header is refused outright** (file 14): the parser reads the
   title as the header, sees one column, and rejects the file as not a billing export. Anything
   re-saved from Excel or exported by a third-party tool can look like this.
3. **A usage-metric export is read as if it were money** (file 16b). It parses, warns
   `currency_unknown`, and reports unlabelled quantities where a reader expects dollars. Uploading
   the wrong metric is an easy mistake and we do not catch it.
4. **A real decrease produces silence** (file 12): S3 fell 34% and the report has nothing to say.
   For a product whose value is a decision loop, the month something improves is the month worth
   reporting.
