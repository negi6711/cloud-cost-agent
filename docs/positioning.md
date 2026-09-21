# Positioning: what this is, who buys it, and why

Written 2026-09-20, after reading the real report for a $15k/month AWS export end to end and
concluding that it is a triage artifact rather than a product. This document argues what would have
to be true for it to become one. It separates **what we have measured** from **what we are assuming**,
because the second kind needs customers to settle and the first kind does not.

## 1. The honest description of what we ship today

A visitor uploads a billing export. Within a minute they see what moved, ranked, with the evidence
behind each movement and what the file cannot tell them. No account, no credentials, no integration.

The arithmetic in that report — monthly totals, month-over-month change, ranked services — is
reproducible in Cost Explorer, a spreadsheet, or fifty lines of Python. **We must never build our
argument on the arithmetic.** Anyone can do it, and some of them do it for free.

What is *not* reproducible in those tools, measured on our own test corpus:

| What we produce | Measured example |
|---|---|
| The allocation gap, in dollars and rows | "96.9% of May 2026 spend ($59,777.31) sits on rows with no team tag, so the export cannot say who owns it" |
| A refusal, when the data cannot support a conclusion | A June truncated at the 18th is detected from the export's own end dates and **not** compared against a full May |
| Named evidence gaps per finding | "This export has no usage-type breakdown, so what is missing first is resource-level billing" |
| Provenance for every number | Every figure traces to the rows it came from: `L5, L6, L8 and 6 more` |
| Decision memory | "Since June 2026: Amazon EC2 is still here and larger; Amazon S3 is no longer a finding" (ADR 0005) |

Our category is **evidence discipline and decision memory**, not cost visibility. If we cannot
defend that sentence in a customer conversation, we should stop building and rethink the product,
not the feature list.

## 2. Who this is for

**The buyer we can serve now:** a 20–200 person engineering organisation with a material AWS bill
and no FinOps function. A platform or infrastructure lead owns the bill by accident. Once a month
they open Cost Explorer, see that the bill moved, and spend a half day establishing what changed and
who caused it — and often still cannot answer the second half.

**The buyer we can serve next:** the FinOps analyst at the size above, who *can* compute all of this
and whose real problem is different — getting engineers to act, and proving their own impact. For
them our artifact is the monthly narrative they currently hand-assemble, with the owner and the
evidence request already attached.

**Who this is not for**, and we should say so early: teams with a mature FinOps practice and
tooling; anyone wanting autonomous remediation; anyone expecting a guaranteed percentage saved.

## 3. The buying case

Things get bought when they add profit or free time that can be shown to add profit. Three lines,
in descending order of how well we can defend them.

**(a) Detection latency — the strongest, and the one we should lead with.**

We do not save money. **We shorten the distance between "the bill moved" and "someone owns it".**
That distance is measured in days, and days × drift rate = dollars.

In the test file, ECS rose $3,314.89 in one month. If that drift is caught at the start of the next
billing period rather than a month later, the arithmetic is $3,314.89 kept, once, plus the
recurrence that never happens. **One catch a year pays for a year of the product several times
over.** That claim is defensible because it is conditional and arithmetic — it does not assert that
any particular spend was wasteful, which billing data cannot show.

**(b) Time on the monthly review.**

The report is the first draft of a monthly cost narrative, with row-level citations, produced in
about a minute. *Assumption to validate: the hand-assembled version takes a competent analyst 3–6
hours, and review of a good draft takes about 30 minutes.* At a loaded $90/hour that is $270–540 a
month. Thin on its own — it is a supporting argument, not the pitch.

**(c) Allocation coverage as a reportable KPI.**

Allocation coverage is something FinOps functions are measured on and report upward. We produce the
percentage, the dollars and the rows behind it, from a file, with no tagging project required first.
Moving coverage from 60% to 90% is a number someone puts in a board deck.

**What we will never claim:** a guaranteed saving, a percentage reduction, or that any spend is
waste. Billing data can show that money moved. It cannot show that money was wasted, that a resource
is idle, or that a change is safe. Every number we publish must survive the question "how do you
know that from a bill?"

## 4. What would make the report great

Assessed against one test: **a platform lead finishing the report can name the next person to talk
to and the next artifact to fetch.** Today we pass the first half and fail the second.

For the ECS finding we name the team (from the customer's own tags) — good. For the data-transfer
finding we say "collect CloudWatch utilization", which is the wrong ask for network spend and sends
the reader back to searching. Five changes close that gap, and four of them need no model at all:

1. **Say what kind of change it is.** Usage growth or a rate change; production or non-production;
   real usage or a credit, tax line or RI fee. All three are computable from columns we currently
   parse past and throw away — and on the very file that prompted this document, the omission sends
   the reader the wrong way. Measured from its `UsageQuantity` column:

   | | May | June | change |
   |---|---|---|---|
   | ECS cost | $5,440.55 | $8,755.44 | **+$3,314.89** |
   | ECS Fargate vCPU-hours | 17,550.17 | 18,221.51 | +3.8% |
   | Effective rate | $0.3100/hr | $0.4805/hr | **+55.0%** |

   Splitting that movement: **$208.12 (6.3%) is volume, $3,106.77 (93.7%) is rate.** Usage barely
   moved. The same +55.0% rate shift appears on all seven services in the file, with flat quantities.
   That pattern is a *billing* event — an expired Savings Plan or Reserved Instance, a credit that
   stopped applying, a pricing or region change — not an engineering one.

   Our report currently tells the reader to ask the platform team what they deployed and to collect
   CloudWatch utilization. Both are the wrong investigation. Nobody deployed anything; the unit price
   changed. This is the clearest evidence in the project that the price-versus-volume split is not a
   refinement but a correctness issue.
2. **Name the thing to open** — account, region, cluster, resource — so the owner does not repeat our
   search by hand.
3. **State coverage.** "These five findings explain 98.5% of a $5,620.36 increase — the top two
   alone are 75.6%; two smaller movements totalling $86.69 were below the materiality threshold."
   That single sentence is what makes the report triage rather than a list, and we already compute
   every number in it.
4. **Make the ask path-specific.** Data transfer needs the traffic path: cross-AZ, cross-region,
   internet egress, NAT gateway, CloudFront. That is a small curated map from usage-type family to
   the right question — domain knowledge we encode once, not a judgement we delegate.
5. ~~**Close the loop next month.**~~ **Built** (ADR 0005): the second upload says what became of
   the first report's findings, matched by subject across workspaces.

## 5. Why the loop is the product

Everything above is still a better report. The thing no incumbent can copy cheaply is **memory of
what was decided**: last month we said ECS needed an owner and a utilization check; this month the
same file says it is still up, or it reversed, or it grew again.

That is the mechanism that converts §3(a) from a plausible story into an audited number — "we
surfaced eleven movements, you acted on four, three reversed, worth $9,400 annualised". Cost Explorer
cannot do it because it has no idea what you decided. It is also the honest basis for a retention
argument: month one is a report, month three is a record.

This document's recommendation is that the loop, not the model, is the next real build.

## 6. Where the model fits

Measured over 58 findings on ten exports (`jev-1.13.0`, 2026-09-20, ADR 0003): the classifier changed
the published decision on 43 of them, used two of our four categories, and had a median confidence of
0.43. Its one confident answer — 0.98 — was the allocation gap, the single case in the corpus where
billing data alone settles the question.

Two readings are possible, and ADR 0004 will decide between them by experiment: either the model is
weak at this task, or we starved it (we ask which team owns a movement while replacing the team name
with `tag_value_01`, and ask about urgency without telling it whether the spend is production).
Either way, **the model is not the differentiator and must not be sold as one.** It is a cheap second
opinion on top of deterministic evidence. The product's weight belongs in the evidence and the loop.

## 7. A caveat about the evidence in this document

The numbers above come from a synthetic corpus, and checking the quantity column exposed a flaw in
it. In **all ten** exports, cost was scaled by a fixed percentage per file while usage quantity was
left flat:

| File | rate change per service | quantity |
|---|---|---|
| 01 normal growth | +10.0% on every service | flat |
| 02 "egress shock" | +55.0% on every service | flat |
| 03 "GPU inference surge" | +80.0% to +83.2% | flat |
| 07 "NAT gateway anomaly" | +75.0% on every service | flat |
| 09 "multi-region GPU" | +93.7% to +95.0% | flat |

So none of the scenarios the manifest describes are actually present in the data. A GPU inference
surge should show GPU-hours rising; these files show GPU-hours flat and the unit price up 80%. The
corpus tests parsing, ranking and wording — it cannot test or validate any reasoning about usage.

Two consequences. First, the claims in §4 about what the product would say differently are sound (a
rate-only movement is exactly what the split would reveal), but the *scenarios* we thought we were
testing were never tested. Second, before the packet experiment in ADR 0004 we need exports whose
economics vary — some volume-driven, some rate-driven, some mixed — or the experiment will conclude
things about a world where only prices ever move.

Worth noting: we did not catch this for a month of testing, because we discard the column that shows
it. That is the argument of this document in miniature.

## 8. Open questions for the first five conversations

1. What does the monthly cost review actually cost you in hours today — and who does it?
2. When something moves, how long is it before the right engineer knows? That number is our value.
3. Is allocation coverage a metric anyone asks you for?
4. Would you upload a billing export to a tool you had not bought yet? (Our whole funnel assumes yes;
   the teaser-first flow exists to test it.)
5. What would have to be in month two for you to still be using this?
