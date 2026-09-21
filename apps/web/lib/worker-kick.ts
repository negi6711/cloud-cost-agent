import "server-only";

import { createHmac } from "node:crypto";
import { after } from "next/server";

import { serverEnv } from "./env";
import { log } from "./log";

/**
 * A sleeping worker takes 30-60 seconds to come back on Render's free plan, and the platform holds
 * the connection open while it boots. The old two-second timeout aborted long before that, so the
 * boot was abandoned and the job sat in the queue — on staging, for fifteen minutes, until someone
 * hit the worker's health endpoint by hand.
 */
const KICK_TIMEOUT_MS = 90_000;

/** How long a run may sit unprocessed before the status endpoint nudges the worker again. */
const REKICK_AFTER_MS = 30_000;

/** Last kick per run, so polling every two seconds cannot turn into kicking every two seconds. */
const lastKick = new Map<string, number>();
const MAX_TRACKED = 1_000;

/** Signature the worker verifies: HMAC-SHA256(secret, "<unix seconds>.kick"), hex. */
export function kickSignature(secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.kick`).digest("hex");
}

/**
 * Nudge the worker to drain the job queue now. The jobs table is the source of truth, so a failed
 * kick only delays processing — but only if the worker is awake to poll, which is exactly what a
 * failed kick means it is not.
 */
export async function kickWorker(requestId: string): Promise<void> {
  const env = serverEnv();
  if (!env.WORKER_URL) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const started = Date.now();
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
    else if (Date.now() - started > 5_000) {
      log.info("worker.kick_woke_a_sleeping_worker", { requestId, ms: Date.now() - started });
    }
  } catch (error) {
    log.warn("worker.kick_failed", { requestId, error });
  }
}

/**
 * Kick after the response has gone out. Waking a sleeping worker takes longer than anyone should
 * wait for an upload to be acknowledged, and the queue does not care who is listening.
 */
export function scheduleKick(requestId: string): void {
  const kick = () => kickWorker(requestId);
  try {
    after(kick);
  } catch {
    // Outside a request context (tests, scripts): run it directly.
    void kick();
  }
}

/**
 * The client polls a run's status every couple of seconds. If the run is still waiting well after
 * it was created, the first kick did not land — so use the poll we are already serving to try
 * again, throttled so it stays a nudge rather than a flood.
 */
export function rekickIfStalled(
  runId: string,
  requestId: string,
  waiting: boolean,
  now: number = Date.now(),
): void {
  if (!waiting) {
    lastKick.delete(runId);
    return;
  }
  const previous = lastKick.get(runId);
  if (previous !== undefined && now - previous < REKICK_AFTER_MS) return;
  if (previous === undefined) {
    // First sighting: give the kick sent at creation time its chance before trying another.
    lastKick.set(runId, now);
    return;
  }
  if (lastKick.size >= MAX_TRACKED) lastKick.clear();
  lastKick.set(runId, now);
  log.info("worker.rekick", { requestId, runId });
  scheduleKick(requestId);
}

/** Tests only: the throttle is module state. */
export function resetKickThrottleForTests(): void {
  lastKick.clear();
}
