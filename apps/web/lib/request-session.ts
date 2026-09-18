import "server-only";

import { decodeLeadSession, LEAD_SESSION_COOKIE, type LeadSession } from "./lead-session";

/** Read one cookie from a request's Cookie header. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function leadSessionFrom(request: Request): LeadSession | null {
  return decodeLeadSession(readCookie(request, LEAD_SESSION_COOKIE));
}
