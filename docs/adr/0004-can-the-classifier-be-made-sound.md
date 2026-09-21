# ADR 0004: Can a richer packet make the classifier sound?

Status: accepted (2026-09-21). Answer: **no**, and the bars said so before we looked.

## Context

ADR 0003 measured that the classifier changes decisions often, uses two of our four categories, and
is barely confident. Two readings were possible: the model is weak at this task, or we starved it.
The second was plausible, because the packet withheld most of what the questions needed — we asked
which team owns a movement while replacing the team name with `tag_value_01`, and asked how urgent
it was without saying whether the spend was production.

Phase 3 fixed the input side: the parser now reads `UsageQuantity`, `UsageUnit`, `Environment` and
`ChargeType`, and every finding carries a usage-versus-rate split and its composition.

**Packet v2** adds, per finding: the usage split (quantities, unit, both effective rates, which
factor dominates), an environment *class* (production / non-production / unknown — never the
customer's literal tag value), the charge type, the composition under the other groupings (aliased
by the same rules as the label), whether the grouping names an owner, and peer context (rank among
the month's movements, share of the bill's increase, how many other movements were material).
**Resource identifiers are still never sent**, per `docs/security.md`.

## The experiment

`worker/scripts/packet_ab.py` runs a corpus twice — same findings, same questions, same thresholds,
only the packet changes. Run on the ICP corpus (17 exports whose scenarios are genuinely volume-,
rate- or allocation-driven), `jev-1.13.0`, 2026-09-21, 15 classified findings per variant.

| | v1 (thin) | v2 (enriched) |
|---|---|---|
| median category confidence | 0.36 | **0.44** |
| confidence range | 0.25–0.65 | 0.34–0.82 |
| distinct categories used | 2 | 2 |
| category counts | INVESTIGATE 11, REQUEST_EVIDENCE 4 | REQUEST_EVIDENCE 10, INVESTIGATE 5 |
| median owner confidence (service findings) | 0.46 | **0.605** |
| `needs_human_review` ≥ 0.5 | 15 of 15 | 15 of 15 |
| agreed with our rules | 5 of 15 | 3 of 15 |

Bars, fixed in advance: **2 of 5 cleared.**

- ❌ median category confidence ≥ 0.60 — reached 0.44
- ❌ at least 3 of 4 categories used — still 2
- ✅ `evidence_sufficient` is not constant
- ❌ `needs_human_review` is not constant — still every finding
- ✅ median owner confidence ≥ 0.60 — 0.46 → 0.605

One of those bars was badly specified by us: `evidence_sufficient` was never constant, it was
*consistently low*. The probability varied all along; ADR 0003 read the derived answer, not the
number. It passes on a technicality and should not count as evidence either way.

## What actually moved

Enrichment helped exactly where the added evidence settles the question, and nowhere else:

* GPU hours up 85% at a flat rate: **0.27 → 0.68**. EBS volume growth: **0.34 → 0.82**. When the
  packet can show that usage moved and price did not, the model commits.
* Owner answers improved because composition names which team or account dominates a movement.
* Everywhere else it hedged *harder*: REQUEST_EVIDENCE went from 4 of 15 to 10 of 15. Told more
  about what it did not have, it asked for more.

**Across 73 findings, two corpora and two packet designs, this model has never once answered
MONITOR or ESCALATE.** That is not a confidence problem, it is a vocabulary the model will not use
on billing evidence: it will say "look into this" or "get more evidence", never "this is fine" and
never "raise the alarm". Those two judgements stay ours.

## Decision

The decision rule was agreed before the run: if v2 cleared the bars, the model earns a real seat and
we revisit its authority; if not, it stays a cheap second opinion while the product's weight goes to
deterministic evidence and the verification loop. **It did not clear them.** The gate stays as
shipped in ADR 0003: our rules publish every category.

**Production reverts to packet v1.** With the model advisory, v2's extra customer-derived content —
usage figures, environment class, charge type, composition — buys no decision, and sending more of a
customer's data for no decision contradicts the minimisation we promise in `docs/security.md`. v2
stays buildable (`build_packet(..., version="ep/2")`) so the next model version can be measured the
same way in an afternoon.

## What would change this answer

* A model that uses all four categories on billing evidence, or is confident enough to be trusted
  with one of them (for example: only MONITOR, where a wrong answer costs a missed small increase).
* Calibration we can check. Confidence is uncalibrated today, so 0.44 and 0.82 are not comparable
  across questions, and the thresholds are guesses dressed as numbers.
* Evidence that is not billing data. The ceiling here is the input, not the model: every question we
  ask that a bill cannot answer gets a hedge, correctly.
