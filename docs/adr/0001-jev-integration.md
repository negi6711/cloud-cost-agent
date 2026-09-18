# ADR 0001 — Jev integration architecture for MVP 0

- **Status:** Accepted (founder-approved 2026-09-18)
- **Scope:** MVP 0 "Cloud Cost Decision Snapshot"
- **Sources verified on 2026-09-18:** docs.typesafe.ai (introduction, models, api, primitives,
  confidence, sdk/javascript, sdk/python), typesafe.ai/legal/mca, typesafe.ai/legal/data-processing,
  typesafe-sdk-js v0.6.0 source.

## Decision

TypeSafe **Jev is called only from the Python worker**, through a `DecisionModelProvider`
interface, using the official Python SDK (`typesafe-sdk`) and the **pinned model `jev-1.13.0`**.
Explanations in Week 1 come from a deterministic `TemplateExplanationProvider`. An optional
`ExplanationLLMProvider` backed by OpenAI `gpt-5-nano` is added in Week 2, disabled by default.

Deterministic code stays authoritative for parsing, arithmetic, thresholds, evidence IDs, policy
gates and prohibited categories. Jev supplies bounded typed classification only.

## Verified Jev contract

| Item | Verified value |
|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>` |
| Request | `{ state, model, questions: { <id>: { type, instructions, criteria } } }` |
| Response | `{ model, answers: { <id>: Answer }, usage: { input_tokens, output_tokens } }` |
| `choice` answer | `choice`, `probabilities`, `confidence` |
| `score` answer | `score`, `legend`, `probabilities`, `confidence` |
| `noul` answer | `noul` (probability of yes, 0–1). **No `confidence`.** |
| Model | `jev-1.13.0`; aliases `jev-latest` / `jev-preview` move on release. Response `model` reports the version that answered. |
| Limits | 64k tokens/request; state + longest question ≤ 32k; ≤ 255 options; 1,200 RPM / 250k TPS, "adjusting dynamically". |
| Price | $0.042 per 1M input tokens; output tokens free. |
| Errors | 401, 422, 429, 529. |
| SDK retry default | 2 retries on 408/429/5xx (incl. 529) and connection errors; 0.5–5 s exponential backoff, 25% jitter; honours `Retry-After`; Python SDK 30 s total budget. |
| Request ID | Python SDK: `result.request_id`, `TypeSafeAPIError.request_id`. Not documented in the HTTP API docs. The JS SDK does not expose it on its result. |
| Idempotency | None offered by the API. |
| Confidence | A statistic of the returned distribution. **Not calibrated.** TypeSafe suggests < 0.5 → human, ≥ 0.9 → high, tuned per domain. |
| Evaluation | Questions are evaluated in parallel and in isolation; one answer is not context for another. |

## Options considered

| Option | Verdict | Reason |
|---|---|---|
| **1. Jev from the Python worker** | **Chosen** | Evidence packet is built next to the Polars facts; the Python SDK exposes request IDs and Pydantic types; policy gate, persistence and replay live in one language and one transaction; the key never touches the internet-facing tier. |
| 2. Jev from the Next.js server | Rejected | The JS SDK hides request IDs; it splits the decision pipeline across two languages; the key would sit on the web tier. |
| 3. Dedicated model-provider service | Deferred | More deployment surface than a solo Week 1 justifies. `worker/src/cca/providers/` is isolated behind interfaces so it can be extracted later without changing callers. |
| 4. Jev + frontier LLM explanations | Week 2 | OpenAI `gpt-5-nano`, chosen for lowest cost. Needs its own consent line and a guard that rejects any number not present in the facts. |
| 5. Jev + deterministic templates | Week 1 | Lowest complexity, fully auditable; always the fallback. |

## Consequences and rules

1. **Consent gate.** A packet is sent to TypeSafe only when the lead ticked the TypeSafe consent
   box (`DATA_PROCESSING_CONSENT_REQUIRED=true`). Otherwise the finding shows deterministic facts plus
   "classification requires human review" (`JEV_UNAVAILABLE_REVIEW_REQUIRED`, reason `no_consent`).
2. **No hidden substitution.** TypeSafe's LLM-backed `system-one-adapter-python` is never used as a
   fallback. If Jev fails, the result is a review-required state, never another model's answer.
3. **Our own idempotency.** A stored successful `model_call` for
   (`packet_sha256`, `question_set_version`, `model`) is reused, never re-called.
4. **Noul confidence.** Derived as the margin `|2p − 1|` and compared to the same threshold.
5. **Materiality.** Deterministic thresholds decide materiality. Jev's `change_material` answer is a
   cross-check only; disagreement sets `review_required`.
6. **Low confidence.** Threshold `JEV_LOW_CONFIDENCE_THRESHOLD` defaults to 0.5 and is provisional.
7. **Pinned model.** Production config pins `jev-1.13.0`; the reported `model` is persisted per call.
8. **Minimized packet.** Account IDs and names are pseudonymized, tag values pseudonymized, labels
   sanitized and truncated, and no email, company, filename or resource ID is sent.

## Privacy and terms gaps (documented, accepted with consent)

- The MCA (§4.1) prohibits training on customer data. The DPA provides EU SCCs, the UK IDTA and a
  72-hour breach notice.
- **Not stated:** processing region, retention period for API payloads, deletion on request,
  specific security certifications. Zero data retention is for enterprise customers only.
- No SLA. Liability cap is the greater of 12 months' fees or $50.
- MCA §5 makes us responsible for holding end-user consent.
- User-facing copy must therefore never claim that TypeSafe deletes submitted data.

## Revisit when

- TypeSafe publishes a region, retention or ZDR option available to our account.
- A new Jev version ships (re-validate thresholds before moving the pin).
- Snapshot volume or provider count justifies extracting a dedicated provider service.
