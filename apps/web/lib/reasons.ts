/** Plain-English text for the worker's policy-gate reasons (worker/src/cca/policy/gate.py). */
const REASONS: Record<string, string> = {
  "classification_unavailable:no_consent": "You did not allow model-assisted classification, so this finding is rule-based.",
  "classification_unavailable:disabled": "Model-assisted classification is switched off, so this finding is rule-based.",
  "classification_unavailable:not_configured": "Model-assisted classification is not configured, so this finding is rule-based.",
  "classification_unavailable:retries_exhausted": "The classification service was unavailable after several attempts; this finding is rule-based.",
  "classification_unavailable:malformed_response": "The classification response failed our checks and was discarded; this finding is rule-based.",
  "classification_unavailable:authentication_failed": "The classification request failed and was not used; this finding is rule-based.",
  "classification_unavailable:request_rejected": "The classification request failed and was not used; this finding is rule-based.",
  "low_confidence:category": "The model was not confident about the next step.",
  "low_confidence:owner": "The model was not confident about the likely owner.",
  "low_confidence:materiality": "The model was not confident about whether the change matters.",
  model_requested_review: "The model suggested a person review this finding.",
  materiality_conflict: "The model and our materiality rule disagree about whether this change matters.",
  readiness_below_threshold: "Data readiness is below 50, so collecting evidence comes first.",
  ownerless_spend_requires_evidence: "New or unallocated spend needs a confirmed owner before it can simply be monitored.",
  material_change_not_monitor_only: "A change this large cannot be monitor-only.",
};

export function reasonText(code: string): string {
  return REASONS[code] ?? "This finding needs a person to review it.";
}

/**
 * Which reasons are worth printing on a card.
 *
 * Every finding in a billing-only snapshot needs human confirmation, and the report says so once,
 * at the top. Repeating it on each card taught the reader to skip the whole section, which buried
 * the rare reasons that do single a finding out. Measured over the Day 7 corpus (58 findings):
 * "the model suggested a person review this" fired 58 times and a materiality disagreement twice.
 *
 * So: drop the constant one, keep anything about our rules or a missing classifier, and keep a
 * low-confidence note only when the model was barely better than a coin toss.
 */
const BARELY_BETTER_THAN_GUESSING = 0.35;

export function notableReasons(codes: string[], confidence: number | null): string[] {
  return codes.filter((code) => {
    if (code === "model_requested_review") return false;
    if (code.startsWith("low_confidence:")) {
      return confidence !== null && confidence < BARELY_BETTER_THAN_GUESSING;
    }
    return true;
  });
}

export const CATEGORY_TEXT: Record<string, string> = {
  INVESTIGATE: "Investigate",
  REQUEST_EVIDENCE: "Request evidence",
  MONITOR: "Monitor",
  ESCALATE: "Escalate",
};

export const CATEGORY_STYLE: Record<string, string> = {
  INVESTIGATE: "bg-sky-100 text-sky-900",
  REQUEST_EVIDENCE: "bg-amber-100 text-amber-900",
  MONITOR: "bg-slate-200 text-slate-800",
  ESCALATE: "bg-rose-100 text-rose-900",
};
