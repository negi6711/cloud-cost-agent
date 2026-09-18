import "server-only";

import { sql } from "drizzle-orm";

import { getAuth } from "./auth";
import { identityDb } from "./db";
import { serverEnv } from "./env";

/** Who is looking: a signed-in prospect (their workspaces) or the founder (every workspace). */
export interface Viewer {
  email: string;
  isAdmin: boolean;
  /** Workspaces this verified email may view. Empty for admins who are not also leads. */
  tenantIds: string[];
}

export async function getViewer(headers: Headers): Promise<Viewer | null> {
  const session = await getAuth().api.getSession({ headers });
  if (!session?.user?.email || !session.user.emailVerified) return null;
  const email = session.user.email.toLowerCase();
  const rows = await identityDb().execute<{ tenant_id: string }>(
    sql`select tenant_ids_for_email(${email}) as tenant_id`,
  );
  return {
    email,
    isAdmin: serverEnv().ADMIN_EMAILS.includes(email),
    tenantIds: rows.rows.map((r) => r.tenant_id),
  };
}
