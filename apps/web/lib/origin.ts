import "server-only";

import { serverEnv } from "./env";

/**
 * Defense in depth against cross-site requests on state-changing routes: a browser-sent Origin
 * must be our own. Requests without an Origin header (server-to-server, tests) are allowed; the
 * SameSite=Lax session cookies already keep cross-site browsers from carrying credentials.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(serverEnv().APP_BASE_URL).origin;
  } catch {
    return false;
  }
}
