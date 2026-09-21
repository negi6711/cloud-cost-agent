# Snapshot analysis (`worker/src/cca/{normalization,detectors,snapshots,policy}`)

```
parsed records -> monthly view -> detectors -> readiness -> evidence packets
  -> model classification (provider) -> policy gate -> template explanations -> one DB transaction
```

Every number is computed by code. A model can only suggest a category, owner, urgency, risk and
missing evidence; the policy gate decides.

## Comparison

The latest two **consecutive complete** months (never a partial or month-to-date month). Without
them the snapshot **abstains**: status `insufficient_data`, no change findings, reason shown to the
user.

## Provisional thresholds (`detectors/thresholds.py`)

| Rule | Value |
|---|---|
| Absolute materiality | `max(500, 5% of mean monthly spend over complete months)` in the file's currency |
| Relative materiality | +20% month over month, and at least 25% of the absolute threshold |
| New service | first charge this month and ≥ 5% of this month's spend (or absolutely material) |
| Unallocated spend | catch-all labels (`No tag key…`, `Others`) ≥ 10% of this month |
| Severity | high ≥ 3× absolute threshold; medium ≥ 1×; else low |
| Findings | at most 10, all from the grouping the export is built around (its primary dimension) |
| Components | up to 3 per finding, one per other grouping, each explaining ≥ 15% of the movement |
| Usage split | volume vs rate effect per finding, when every row carries a quantity; ≥ 70% of the effect one way decides "more usage" or "a higher price" |

### What each finding is short of

The missing-evidence list is computed per finding from what the export turned out to contain, not
fixed per finding kind:

| The export … | so the card asks for |
|---|---|
| has no team tag or cost category | allocation tags — nobody can be asked who owns this yet |
| has tags, and one team covers ≥ 90% of the movement | nothing about ownership; the file already names them |
| has tags, and the movement spans teams | owner confirmation |
| shows flat usage at a higher unit price | Savings Plan or Reserved Instance coverage — utilization cannot explain a price move |
| has a usage-type or instance-type breakdown | CloudWatch utilization for the affected resources |
| has neither | resource-level billing (a Cost and Usage Report) |

Change context is always last, because "ask the owning team what changed" already says it. At most
three items. The model's `primary_missing_evidence` answer is appended only when it names a gap the
rules did not; it is never put first, because measured over the Day 7 corpus it answered
`change_context` for 28 of 29 increases, and a constant is not a ranking (ADR 0003).

When one team covers nearly all of a movement, the next action names them: "Ask ML Platform what
changed in June 2026 and collect CloudWatch utilization for the affected resources before deciding
anything."

### One movement, one finding

Every row has exactly one value in the primary grouping, so movements in it partition the bill and
none of them restates another. The export's other groupings describe the *same rows* from a
different angle: an account, a region and a team tag can all be another way of saying "EC2 went up".
They are therefore folded into the finding as **components** — "$7,690.21 of it (67.3%) is
g5.48xlarge OnDemand (usage type)" — rather than ranked as decisions of their own. A grouping with a
single value across the export is skipped: "all of it is in the only account you have" is not a
fact. Before this, a $19,198 increase on one service could appear as five findings whose shares of
the bill's increase summed past 100%.

## Findings and default categories (before any model)

| Kind | Default |
|---|---|
| `new_service` | REQUEST_EVIDENCE |
| `unallocated_spend` | REQUEST_EVIDENCE |
| `material_increase`, absolute, ≥ 3× the absolute threshold and the **change** is ≥ 10% of the month | ESCALATE |
| `material_increase`, absolute | INVESTIGATE |
| `material_increase`, relative only | MONITOR |

Each finding has a stable evidence ID `ev_<file sha256[:12]>_<kind>_<dimension>_<label hash>_<YYYYMM>`
and up to 20 source cell references (`L5:C7`).

## Data-readiness score (`snapshots/readiness.py`, provisional)

periods 30 · row quality 20 · reconciliation 10 · currency 10 · duplicates 5 · dimension coverage 10 ·
allocation 15. The canonical service-grouped export scores 85.

## Policy gate (`policy/gate.py`)

**The rules decide the category. A model answer is a second opinion recorded beside the decision,
never the decision** (ADR 0003 has the measurement that prompted this).

1. The published category is the deterministic default for the finding, one of INVESTIGATE,
   REQUEST_EVIDENCE, MONITOR, ESCALATE (enum + DB CHECK), stored in both `rule_category` and
   `final_category`.
2. Readiness < 50 → REQUEST_EVIDENCE, whatever the default said.
3. Review is required when: no classification ran (`JEV_UNAVAILABLE_REVIEW_REQUIRED`, reason
   `classification_unavailable:<disabled|no_consent|…>`); confidence is below
   `JEV_LOW_CONFIDENCE_THRESHOLD` (default 0.5) → `JEV_LOW_CONFIDENCE`; the model asked for review;
   or the model disagrees with rule materiality. Yes/no answers carry no confidence, so they are
   judged by `|2p−1|` against `JEV_NOUL_MARGIN_THRESHOLD` (default 0.3, i.e. at least 65% one way) —
   tuned against real Jev answers, which sat around 0.53-0.73 on the sample export.
4. `POLICY_BLOCKED` now means the model suggested a different category from the one we published.
   Its answer stays in `jev_category`, and the report says so on the card.

Two earlier rules are gone: "new or unallocated spend is never MONITOR" and "a high-severity
material change is never MONITOR". Both bounded a model answer, and neither can fire against our own
defaults — ownerless spend already defaults to REQUEST_EVIDENCE, and a MONITOR default means the
change was not absolutely material, which is what the second rule required.

## Evidence packet v1 (`snapshots/packet.py`)

Per finding: run context (period, comparison months, currency, totals, readiness, data-quality
codes, limitations) and the finding (kind, dimension, label, monthly history, change, share).
Account/tag/cost-category values are aliased (`acct_01`); account IDs and emails in labels are
masked; instruction-like, URL or formula labels are withheld. Rule outcomes are **not** included.
Canonical JSON (sorted keys, decimals as strings) → SHA-256, stored in `evidence_packet`.

## Explanations (`snapshots/explain.py`)

`TemplateExplanationProvider` builds each card from computed facts: title, what changed, what we
know (with cell references), what is missing, safest next action. Next actions never suggest
resizing, deleting, stopping or buying commitments (tested across all fixtures).
