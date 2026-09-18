/** A complete, valid qualification form submission. */
export const validLead = {
  email: "  Alex@Acme.io ",
  firstName: "Alex",
  companyName: "Acme",
  companyWebsite: "https://www.acme.io/about",
  role: "Head of Platform",
  country: "GB",
  provider: "AWS",
  spendBand: "25k_75k",
  biggestProblem: "Our ECS bill jumped 30% last month and nobody knows why.",
  contactPermission: true,
} as const;
