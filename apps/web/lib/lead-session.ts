import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { serverEnv } from "./env";

/**
 * Short-lived, signed, httpOnly cookie that lets the browser that just submitted the qualification
 * form upload a file for that lead. It is not a login: viewing results requires the magic link.
 */
export const LEAD_SESSION_COOKIE = "cca_lead";
export const LEAD_SESSION_TTL_SECONDS = 2 * 60 * 60;

export interface LeadSession {
  leadId: string;
  tenantId: string;
  exp: number; // unix seconds
}

function key(): Buffer {
  // Domain-separated from other uses of AUTH_SECRET.
  return createHmac("sha256", serverEnv().AUTH_SECRET).update("cca/lead-session/v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

export function encodeLeadSession(session: Omit<LeadSession, "exp">, now = Date.now()): string {
  const full: LeadSession = { ...session, exp: Math.floor(now / 1000) + LEAD_SESSION_TTL_SECONDS };
  const payload = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeLeadSession(token: string | undefined, now = Date.now()): LeadSession | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LeadSession;
    if (typeof parsed.leadId !== "string" || typeof parsed.tenantId !== "string") return null;
    if (typeof parsed.exp !== "number" || parsed.exp * 1000 <= now) return null;
    return parsed;
  } catch {
    return null;
  }
}
