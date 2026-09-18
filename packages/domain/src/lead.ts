import {
  AWS_ACCOUNT_COUNTS,
  CLOUD_PROVIDERS,
  COUNTRY_CODES,
  PILOT_INTEREST,
  ROLES,
  SPEND_BANDS,
  YES_NO_UNSURE,
} from "@cca/config";
import { z } from "zod";

const trimmed = (max: number) => z.string().trim().min(1, "Required").max(max, `At most ${max} characters`);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters`)
    .optional()
    .transform((v) => (v ? v : undefined));

/**
 * Normalize "acme.com", "www.acme.com" or "https://acme.com/about" to a bare lowercase hostname.
 * Returns null when the input is not a plausible public hostname.
 */
export function normalizeCompanyDomain(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  // Require a dot and a letter TLD; reject IP literals and localhost.
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null;
  return host;
}

export const leadInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid work email").max(254)),
  firstName: trimmed(80),
  companyName: trimmed(120),
  companyWebsite: trimmed(253).refine((v) => normalizeCompanyDomain(v) !== null, {
    message: "Enter your company website, e.g. acme.com",
  }),
  role: z.enum(ROLES, { message: "Choose your role" }),
  country: z.enum(COUNTRY_CODES, { message: "Choose your country" }),
  provider: z.enum(CLOUD_PROVIDERS, { message: "Choose your primary cloud provider" }),
  spendBand: z.enum(SPEND_BANDS, { message: "Choose your monthly spend band" }),
  biggestProblem: trimmed(1000),
  contactPermission: z.literal(true, { message: "We need permission to contact you about your snapshot" }),

  awsAccountCount: z.enum(AWS_ACCOUNT_COUNTS).optional(),
  kubernetesUsage: z.enum(YES_NO_UNSURE).optional(),
  aiGpuUsage: z.enum(YES_NO_UNSURE).optional(),
  recentBillShock: optionalText(500),
  desiredOutcome: optionalText(500),
  pilotInterest: z.enum(PILOT_INTEREST).optional(),

  /** Honeypot: hidden from people, filled by naive bots. Must be empty. */
  faxNumber: z.string().max(0).optional(),
});

export type LeadInput = z.infer<typeof leadInputSchema>;

/** Contact basis recorded with each lead; bump the version when the form wording changes. */
export const CONTACT_BASIS = "consent:contact-form-v1";
