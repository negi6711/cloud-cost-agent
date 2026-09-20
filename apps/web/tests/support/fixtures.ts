/** A complete, valid submission of the email gate shown under the teaser. */
export const validUnlock = {
  email: "  Alex@Acme.io ",
  firstName: "Alex",
  companyName: "Acme",
  role: "Head of Platform",
  processingConsent: true,
  typesafeConsent: true,
} as const;

/** The optional qualification answers, asked after unlock. */
export const validProfile = {
  country: "GB",
  provider: "AWS",
  spendBand: "25k_75k",
  biggestProblem: "Our ECS bill jumped 30% last month and nobody knows why.",
  contactPermission: true,
} as const;
