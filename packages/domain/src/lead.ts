import { CLOUD_PROVIDERS, COUNTRY_CODES, ROLES, SPEND_BANDS } from "@cca/config";
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
 * The email gate, shown under the teaser: the minimum needed to deliver the report and follow up.
 * The remaining qualification questions (country, provider, spend band, problem) are asked after
 * unlock, on the report page, so the gate stays short.
 */
export const unlockSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid work email").max(254)),
  firstName: trimmed(80),
  companyName: trimmed(120),
  role: z.enum(ROLES).optional(),
  /** Required: process the uploaded billing evidence and send the report. */
  processingConsent: z.literal(true, { message: "We need your permission to process the file and email your report" }),
  /** Optional: minimized evidence packet may be processed by TypeSafe Jev. */
  typesafeConsent: z.boolean().default(false),
  /** Honeypot: hidden from people, filled by naive bots. Must be empty. */
  faxNumber: z.string().max(0).optional(),
});
export type UnlockInput = z.infer<typeof unlockSchema>;

/** Asked after unlock, on the report page. Every field optional: it is a nudge, not a gate. */
export const profileSchema = z.object({
  country: z.enum(COUNTRY_CODES).optional(),
  provider: z.enum(CLOUD_PROVIDERS).optional(),
  spendBand: z.enum(SPEND_BANDS).optional(),
  biggestProblem: optionalText(1000),
  contactPermission: z.boolean().optional(),
});
export type ProfileInput = z.infer<typeof profileSchema>;

/** Contact basis recorded with each lead; bump the version when the form wording changes. */
export const CONTACT_BASIS = "consent:unlock-form-v1";
