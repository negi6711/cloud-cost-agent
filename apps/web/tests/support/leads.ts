import { leadInputSchema } from "@cca/domain";

import { encodeLeadSession, LEAD_SESSION_COOKIE, type LeadSession } from "@/lib/lead-session";
import { createLead } from "@/lib/leads";

import { validLead } from "./fixtures";

export interface TestLead {
  session: LeadSession;
  cookie: string;
}

let counter = 0;

/** A persisted lead plus the Cookie header its browser would send. */
export async function makeLead(): Promise<TestLead> {
  counter += 1;
  const input = leadInputSchema.parse({
    ...validLead,
    email: `lead${counter}@example-co.com`,
    companyName: `Company ${counter}`,
  });
  const { leadId, tenantId } = await createLead(input);
  const token = encodeLeadSession({ leadId, tenantId });
  return {
    session: { leadId, tenantId, exp: 0 },
    cookie: `${LEAD_SESSION_COOKIE}=${encodeURIComponent(token)}`,
  };
}

export function jsonRequest(url: string, body: unknown, cookie?: string, method = "POST"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}
