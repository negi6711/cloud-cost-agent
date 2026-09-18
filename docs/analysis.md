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
| Findings | at most 10; secondary dimensions (account, region) at most 3 each, and only when they have ≥ 2 values |

## Findings and default categories (before any model)

| Kind | Default |
|---|---|
| `new_service` | REQUEST_EVIDENCE |
| `unallocated_spend` | REQUEST_EVIDENCE |
| `material_increase`, absolute, high severity and ≥ 10% of the month | ESCALATE |
| `material_increase`, absolute | INVESTIGATE |
| `material_increase`, relative only | MONITOR |

Each finding has a stable evidence ID `ev_<file sha256[:12]>_<kind>_<dimension>_<label hash>_<YYYYMM>`
and up to 20 source cell references (`L5:C7`).

## Data-readiness score (`snapshots/readiness.py`, provisional)

periods 30 · row quality 20 · reconciliation 10 · currency 10 · duplicates 5 · dimension coverage 10 ·
allocation 15. The canonical service-grouped export scores 85.

## Policy gate (`policy/gate.py`)

1. The category is one of INVESTIGATE, REQUEST_EVIDENCE, MONITOR, ESCALATE (enum + DB CHECK).
2. No classification → rule default, `JEV_UNAVAILABLE_REVIEW_REQUIRED`, review required, reason
   `classification_unavailable:<disabled|no_consent|…>`.
3. Confidence below `JEV_LOW_CONFIDENCE_THRESHOLD` (default 0.5; yes/no answers use `|2p−1|`) →
   `JEV_LOW_CONFIDENCE`, review required.
4. Model-requested review, or disagreement with rule materiality → review required.
5. Readiness < 50 → REQUEST_EVIDENCE.
6. New or unallocated spend → never MONITOR (REQUEST_EVIDENCE).
7. High-severity material change → never MONITOR (INVESTIGATE).

Rules 5–7 overriding a model answer set `POLICY_BLOCKED`; the model's answer stays in `jev_category`.

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
