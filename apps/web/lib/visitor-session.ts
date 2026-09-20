import "server-only";

import { tenant } from "@cca/db";

import { withTenant } from "./db";
import { serverEnv } from "./env";
import { signToken, verifyToken } from "./signing";

/**
 * Uploads happen before we know who the visitor is, so the first upload creates an empty workspace
 * and this signed, httpOnly cookie binds the browser to it. It is not a login: it grants only the
 * teaser for files uploaded in that workspace. The full report still needs a verified email.
 */
export const VISITOR_COOKIE = "cca_visitor";
export const VISITOR_TTL_SECONDS = 24 * 60 * 60;
const PURPOSE = "visitor-session/v1";

export interface VisitorSession {
  tenantId: string;
  exp: number;
}

export function encodeVisitorSession(tenantId: string, now = Date.now()): string {
  return signToken(serverEnv().AUTH_SECRET, PURPOSE, { tenantId }, VISITOR_TTL_SECONDS, now);
}

export function decodeVisitorSession(token: string | undefined, now = Date.now()): VisitorSession | null {
  const payload = verifyToken<{ tenantId: string }>(serverEnv().AUTH_SECRET, PURPOSE, token, now);
  return payload && typeof payload.tenantId === "string" ? payload : null;
}

/** A workspace for an anonymous visitor. Named properly when they unlock with a company name. */
export async function createVisitorWorkspace(): Promise<string> {
  const tenantId = crypto.randomUUID();
  await withTenant(tenantId, (tx) => tx.insert(tenant).values({ id: tenantId, tenantId, name: "Unclaimed upload" }));
  return tenantId;
}
