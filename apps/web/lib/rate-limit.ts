import "server-only";

import { serverEnv } from "./env";

/**
 * Fixed-window, per-client limits for public write endpoints. In-memory: correct for the single
 * web instance MVP 0 runs on; move to a shared store (Postgres/Redis) before scaling out.
 * Disabled only when APP_ENV=test, where every request comes from one address.
 */
export const LIMITS = {
  lead: { limit: 10, windowMs: 10 * 60_000 },
  upload: { limit: 30, windowMs: 10 * 60_000 },
  snapshot: { limit: 20, windowMs: 10 * 60_000 },
  pilot: { limit: 10, windowMs: 10 * 60_000 },
  delete: { limit: 20, windowMs: 10 * 60_000 },
  admin: { limit: 120, windowMs: 60_000 },
} as const;
export type LimitName = keyof typeof LIMITS;

interface Window {
  start: number;
  count: number;
}

const windows = new Map<string, Window>();
const MAX_TRACKED = 50_000;

export interface LimitResult {
  ok: boolean;
  retryAfterSeconds: number;
}

export function checkLimit(name: LimitName, clientKey: string, now = Date.now()): LimitResult {
  if (serverEnv().APP_ENV === "test") return { ok: true, retryAfterSeconds: 0 };
  const { limit, windowMs } = LIMITS[name];
  const key = `${name}:${clientKey}`;
  let w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    if (windows.size >= MAX_TRACKED) windows.clear(); // bounded memory under abuse
    w = { start: now, count: 0 };
    windows.set(key, w);
  }
  w.count += 1;
  if (w.count > limit) return { ok: false, retryAfterSeconds: Math.ceil((w.start + windowMs - now) / 1000) };
  return { ok: true, retryAfterSeconds: 0 };
}

/** The client address as seen by the platform's proxy (first X-Forwarded-For entry). */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export function resetRateLimitsForTests(): void {
  windows.clear();
}
