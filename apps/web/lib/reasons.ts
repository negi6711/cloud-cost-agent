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
