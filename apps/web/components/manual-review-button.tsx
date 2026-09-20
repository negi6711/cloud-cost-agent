"use client";

import { useState } from "react";

/**
 * Ask for a person to go through the snapshot instead of (or as well as) reading it. Only shown on
 * the report page: a request to be contacted needs an identity behind it.
 */
export function ManualReviewButton({ snapshotRunId }: { snapshotRunId: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function request() {
    setState("sending");
    try {
      const res = await fetch("/api/pilot-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotRunId, manualReviewOnly: true }),
      });
      setState(res.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <p role="status" className="text-sm text-muted">
        Thanks — we will email you to arrange a review of this snapshot.
      </p>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={request}
        disabled={state === "sending"}
        className="rounded-lg border border-border bg-white px-4 py-2 text-sm font-semibold hover:bg-subtle disabled:opacity-50"
      >
        {state === "sending" ? "Sending…" : "Ask us to review this with you"}
      </button>
      <div role="status" aria-live="polite">
        {state === "error" && <p className="mt-2 text-sm text-danger">That did not send. Please try again.</p>}
      </div>
    </div>
  );
}
