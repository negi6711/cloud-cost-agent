import "server-only";

import { createHmac } from "node:crypto";

import { serverEnv } from "./env";
import { log } from "./log";

const KICK_TIMEOUT_MS = 2_000;

/** Signature the worker verifies: HMAC-SHA256(secret, "<unix seconds>.kick"), hex. */
export function kickSignature(secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.kick`).digest("hex");
}

/**
 * Nudge the worker to drain the job queue now. Best effort: the jobs table is the source of truth
 * and the worker also polls, so a failed kick only delays processing. On Render's free plan the
 * request also wakes a sleeping worker.
 */
export async function kickWorker(requestId: string): Promise<void> {
  const env = serverEnv();
  if (!env.WORKER_URL) return;
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(new URL("/internal/kick", env.WORKER_URL), {
      method: "POST",
      headers: {
        "x-cca-timestamp": String(timestamp),
        "x-cca-signature": kickSignature(env.WORKER_SHARED_SECRET, timestamp),
        "x-request-id": requestId,
      },
      signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
    });
    if (!res.ok) log.warn("worker.kick_rejected", { requestId, status: res.status });
  } catch (error) {
    log.warn("worker.kick_failed", { requestId, error });
  }
}
