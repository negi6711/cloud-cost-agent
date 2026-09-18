/** Option lists for the qualification form (docs/product-spec.md §2, §5). */

export const FIRST_WAVE_COUNTRIES = [
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "CA", label: "Canada" },
  { code: "SG", label: "Singapore" },
  { code: "AU", label: "Australia" },
  { code: "IL", label: "Israel" },
  { code: "IE", label: "Ireland" },
  { code: "NL", label: "Netherlands" },
  { code: "DE", label: "Germany" },
  { code: "IN", label: "India" },
  { code: "PL", label: "Poland" },
  { code: "EE", label: "Estonia" },
  { code: "OTHER", label: "Other" },
] as const;
export type CountryCode = (typeof FIRST_WAVE_COUNTRIES)[number]["code"];
export const COUNTRY_CODES = FIRST_WAVE_COUNTRIES.map((c) => c.code) as [
  CountryCode,
  ...CountryCode[],
];

export const ROLES = [
  "CTO",
  "VP Engineering",
  "Head of Platform",
  "DevOps/SRE lead",
  "FinOps practitioner",
  "ML infrastructure lead",
  "CFO or finance lead",
  "Other",
] as const;
export type Role = (typeof ROLES)[number];

export const CLOUD_PROVIDERS = ["AWS", "GCP", "Azure", "Multi-cloud", "Other"] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export const AWS_ACCOUNT_COUNTS = ["1", "2-5", "6-20", "21+", "Not sure"] as const;
export const YES_NO_UNSURE = ["Yes", "No", "Not sure"] as const;
export const PILOT_INTEREST = ["Yes", "Maybe", "No"] as const;
