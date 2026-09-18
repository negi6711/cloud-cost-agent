/**
 * Fixed product vocabularies from the MVP 0 specification (docs/product-spec.md §5, §7).
 * The Python worker defines the same values; a contract test keeps them in sync.
 */

export const SPEND_BANDS = [
  "under_5k",
  "5k_10k",
  "10k_25k",
  "25k_75k",
  "75k_100k",
  "over_100k",
  "not_sure",
] as const;
export type SpendBand = (typeof SPEND_BANDS)[number];

export const SPEND_BAND_LABELS: Record<SpendBand, string> = {
  under_5k: "Under $5k/month",
  "5k_10k": "$5k–$10k/month",
  "10k_25k": "$10k–$25k/month",
  "25k_75k": "$25k–$75k/month",
  "75k_100k": "$75k–$100k/month",
  over_100k: "Over $100k/month",
  not_sure: "Not sure",
};

/** The only live decision categories. RESIZE / DELETE / STOP / BUY COMMITMENT are not representable. */
export const DECISION_CATEGORIES = [
  "INVESTIGATE",
  "REQUEST_EVIDENCE",
  "MONITOR",
  "ESCALATE",
] as const;
export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

export const DECISION_CATEGORY_LABELS: Record<DecisionCategory, string> = {
  INVESTIGATE: "Investigate",
  REQUEST_EVIDENCE: "Request evidence",
  MONITOR: "Monitor",
  ESCALATE: "Escalate",
};
