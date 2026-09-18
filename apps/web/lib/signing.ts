import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compact signed tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 * Each purpose derives its own key from the secret, so a token minted for one purpose can never be
 * accepted for another. Payloads always carry `exp` (unix seconds).
 */
export interface Expiring {
  exp: number;
}

function purposeKey(secret: string, purpose: string): Buffer {
  return createHmac("sha256", secret).update(`cca/${purpose}`).digest();
}

function mac(secret: string, purpose: string, payload: string): string {
  return createHmac("sha256", purposeKey(secret, purpose)).update(payload).digest("base64url");
}

export function signToken<T extends object>(
  secret: string,
  purpose: string,
  payload: T,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const full = { ...payload, exp: Math.floor(now / 1000) + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${encoded}.${mac(secret, purpose, encoded)}`;
}

/** Returns the payload, or null if the token is malformed, forged, for another purpose, or expired. */
export function verifyToken<T extends object>(
  secret: string,
  purpose: string,
  token: string | undefined | null,
  now = Date.now(),
): (T & Expiring) | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];
  const expected = Buffer.from(mac(secret, purpose, encoded));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T & Expiring;
    if (typeof payload !== "object" || payload === null) return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}
