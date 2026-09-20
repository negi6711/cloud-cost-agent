import "server-only";

import { lead } from "@cca/db";
import { withTenant } from "./db";
import { decodeVisitorSession, VISITOR_COOKIE } from "./visitor-session";

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

export interface UploadSession {
  tenantId: string;
}

/** The workspace this browser owns, from the visitor cookie set at the first upload. */
export function visitorSessionFrom(request: Request): UploadSession | null {
  const session = decodeVisitorSession(readCookie(request, VISITOR_COOKIE));
  return session ? { tenantId: session.tenantId } : null;
}

/** The lead in this workspace, once the visitor has unlocked the report with their email. */
export async function leadForTenant(tenantId: string): Promise<{ id: string; email: string } | null> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ id: lead.id, email: lead.email }).from(lead).limit(1),
  );
  return row ?? null;
}

export async function leadIdForTenant(tenantId: string): Promise<string | null> {
  return (await leadForTenant(tenantId))?.id ?? null;
}
