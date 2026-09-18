import "server-only";

import { serverEnv } from "./env";
import { signToken, verifyToken } from "./signing";

/**
 * Short-lived, signed, httpOnly cookie that lets the browser that just submitted the qualification
 * form upload a file for that lead. It is not a login: viewing results requires the magic link.
 */
export const LEAD_SESSION_COOKIE = "cca_lead";
export const LEAD_SESSION_TTL_SECONDS = 2 * 60 * 60;
const PURPOSE = "lead-session/v1";

export interface LeadSession {
  leadId: string;
  tenantId: string;
  exp: number; // unix seconds
}

export function encodeLeadSession(session: Omit<LeadSession, "exp">, now = Date.now()): string {
  return signToken(serverEnv().AUTH_SECRET, PURPOSE, session, LEAD_SESSION_TTL_SECONDS, now);
}

export function decodeLeadSession(token: string | undefined, now = Date.now()): LeadSession | null {
  const payload = verifyToken<Omit<LeadSession, "exp">>(serverEnv().AUTH_SECRET, PURPOSE, token, now);
  if (!payload || typeof payload.leadId !== "string" || typeof payload.tenantId !== "string") {
    return null;
  }
  return payload;
}
