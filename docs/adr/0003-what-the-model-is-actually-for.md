# ADR 0003: Keep what our rules decided, so we can tell what the model is for

Status: accepted (2026-09-20). Both decisions are implemented.

## Context

`snapshot_finding` stored the model's suggestion (`jev_category`) and the published answer
(`final_category`), but not the category our deterministic rules produced on their own. That made
the most important question about a paid dependency unanswerable after the fact: **does the model
change any decision, or does it restate ours?**

To answer it once, `worker/scripts/jev_agreement.py` ran 10 synthetic AWS exports (the Day 7 test
set: small SaaS through large multi-region AI, one partial-period file) through the real classifier
and compared all three answers per finding. 58 findings, `jev-1.13.0`, 2026-09-20.

## What the measurement showed

| Our rules | Jev | Count |
|---|---|---|
| ESCALATE | REQUEST_EVIDENCE | 16 |
| INVESTIGATE | INVESTIGATE | 14 *(same)* |
| MONITOR | INVESTIGATE | 13 |
| ESCALATE | INVESTIGATE | 9 |
| INVESTIGATE | REQUEST_EVIDENCE | 4 |
| MONITOR | REQUEST_EVIDENCE | 1 |
| REQUEST_EVIDENCE | REQUEST_EVIDENCE | 1 *(same)* |

* **Jev changed the decision on 43 of 58 findings (74%).** It is not a rubber stamp.
* **The disagreement has one shape.** It pulls both extremes toward the middle: it never accepted an
  ESCALATE (25 of ours became REQUEST_EVIDENCE or INVESTIGATE) and never accepted a MONITOR (14 of
  ours became INVESTIGATE or REQUEST_EVIDENCE).
* **Jev used two of the four categories.** Across 58 findings it answered only INVESTIGATE (36) or
  REQUEST_EVIDENCE (22) — never MONITOR, never ESCALATE. On billing-only evidence that is a
  defensible position, and it is close to the product's own thesis: a bill can show that money
  moved and almost never show that anything is urgent or safe to ignore.
* **The policy gate never had to intervene** (0 overrides), because Jev's two answers never trip
  rules written to stop a model calling material or ownerless spend "just monitor".
* **Confidence is low and its spread is narrow**: min 0.27, median 0.43, max 0.98. The single
  high-confidence answer (0.98) is the allocation-gap finding in the partial-period file — the one
  case in the corpus where billing data alone settles the question. The model is not uniformly
  unsure; it is unsure exactly where the evidence is thin.
* **Every finding was flagged for human review** (58/58): `model_requested_review` fired 58 times,
  `low_confidence:category` 44, `low_confidence:owner` 14, `low_confidence:materiality` 10, and
  `materiality_conflict` twice.

## Decision 1 (implemented)

`snapshot_finding.rule_category` stores `candidate.default_category`, written in the same upsert as
the rest of the finding (migration 0012). The report names it when it differs from the model's
suggestion: "Without the model, our rules alone would have said X." The founder can now run the
agreement query on real customer runs, not only on fixtures.

## Decision 2 (implemented): say it once, not 58 times

A flag that is true for every finding tells a reader nothing. Three ways out, in preference order:

1. **Say it once, not 58 times.** State at the top of the report that every finding needs human
   confirmation, and reserve the per-finding notice for the specific, rare signals:
   `materiality_conflict` (2 of 58) and confidence in the bottom band (<0.35, 15 of 58). This keeps
   the policy exactly as strict and makes the badge mean something again.
2. **Recalibrate the threshold** from 0.5 to about 0.35 to match Jev's observed range. Cheaper, but
   it treats an uncalibrated number as if it were calibrated, which the disclosure explicitly says
   it is not.
3. **Drop `model_requested_review` as a trigger** since it is constant at this model version. Keeps
   the other triggers honest, but silently discards a signal that may become informative later.

Option 1 was taken, in the presentation layer only. The gate is unchanged: it still evaluates every
trigger, `review_required` and the full `policy_reasons` list are still stored on every finding, and
the categories it publishes do not change. What changed is what the report prints:

* The report states once, above the findings, that every finding needs a person to confirm it
  before anyone acts, and why — a bill cannot show intent, ownership or safety.
* A card prints a footer only when something singles it out: our rules overriding the model, a
  missing classifier, or confidence below 0.35 (`notableReasons` in `apps/web/lib/reasons.ts`).
  `model_requested_review` is never printed, because at this model version it is constant.
* The footer's heading is "Read this one with extra care", which is a claim about this finding
  rather than a status every finding shares.

On the Day 7 corpus this takes the per-card notice from 58 of 58 findings to roughly 17 — the two
materiality disagreements and the fifteen findings where the model was barely better than guessing.

## Consequences

* One extra text column per finding, and one more thing the unlock phase must write.
* The agreement number is now a metric we can watch per model version. If a future `jev-1.14`
  agrees with our rules 95% of the time, it has stopped earning its cost; if it disagrees in a new
  direction, that is a signal to re-read the questions in `jev_questions_v1.py`.
* `scripts/jev_agreement.py` calls the real API and is therefore not part of the test suite.
