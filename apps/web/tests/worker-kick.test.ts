import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { kickSignature } from "@/lib/worker-kick";

/**
 * The kick is what wakes a sleeping worker. On Render's free plan that takes 30-60 seconds, and a
 * kick that gives up early leaves the job queued with nobody awake to poll for it — which is
 * exactly what happened on staging: a run sat for fifteen minutes until the worker's health
 * endpoint was hit by hand.
 */
describe("waking the worker", () => {
  // The unit-test setup deletes WORKER_URL so nothing kicks by accident; this suite opts in.
  beforeEach(async () => {
    process.env.WORKER_URL = "http://localhost:8001";
    const { resetServerEnvForTests } = await import("@/lib/env");
    resetServerEnvForTests();
    const { resetKickThrottleForTests } = await import("@/lib/worker-kick");
    resetKickThrottleForTests();
  });
  afterEach(async () => {
    delete process.env.WORKER_URL;
    const { resetServerEnvForTests } = await import("@/lib/env");
    resetServerEnvForTests();
    vi.restoreAllMocks();
  });

  it("waits long enough for a sleeping worker to boot", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const { kickWorker } = await import("@/lib/worker-kick");

    await kickWorker("req-1");

    const [, init] = fetchMock.mock.calls[0]!;
    const signal = (init as RequestInit).signal as AbortSignal & { timeout?: number };
    // AbortSignal.timeout does not expose its duration, so assert the behaviour instead: the signal
    // must not already be aborted, and must still be live well past a cold start.
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(signal.aborted).toBe(false);
  });

  it("never lets a failed kick fail the request that scheduled it", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("worker asleep"));
    const { kickWorker } = await import("@/lib/worker-kick");
    await expect(kickWorker("req-2")).resolves.toBeUndefined();
  });

  it("re-kicks a run that is still queued, but not on every poll", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const { rekickIfStalled } = await import("@/lib/worker-kick");

    // The client polls every couple of seconds. The first sighting gives the kick sent at creation
    // its chance; nothing more happens until the run has been waiting a while.
    const t0 = 1_000_000;
    rekickIfStalled("run-1", "req", true, t0);
    for (let i = 1; i < 10; i++) rekickIfStalled("run-1", "req", true, t0 + i * 2_000);
    expect(fetchMock).not.toHaveBeenCalled();

    rekickIfStalled("run-1", "req", true, t0 + 31_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Still queued, still polling: one nudge per interval, not one per poll.
    for (let i = 1; i < 10; i++) rekickIfStalled("run-1", "req", true, t0 + 31_000 + i * 2_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rekickIfStalled("run-1", "req", true, t0 + 62_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("stops tracking a run once it is no longer waiting", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const { rekickIfStalled } = await import("@/lib/worker-kick");

    rekickIfStalled("run-2", "req", true, 1_000);
    rekickIfStalled("run-2", "req", false, 2_000); // it started processing
    rekickIfStalled("run-2", "req", true, 99_000); // back to a first sighting, so no kick yet
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs the kick so only we can send one", () => {
    expect(kickSignature("s".repeat(40), 1_700_000_000)).toMatch(/^[0-9a-f]{64}$/);
    expect(kickSignature("s".repeat(40), 1_700_000_000)).not.toBe(
      kickSignature("s".repeat(40), 1_700_000_001),
    );
  });
});
