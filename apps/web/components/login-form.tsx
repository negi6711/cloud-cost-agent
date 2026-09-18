"use client";

import { type FormEvent, useId, useState } from "react";

/** Requests a magic link. The answer is the same whether or not the email is known. */
export function LoginForm({ callbackURL }: { callbackURL: string }) {
  const emailId = useId();
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("sending");
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    try {
      const res = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, callbackURL }),
      });
      setState(res.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <p role="status" className="rounded-lg bg-subtle p-4 text-sm leading-6">
        If that email has a snapshot with us, a sign-in link is on its way. It works once and expires in
        30 minutes.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="flex flex-col gap-1">
        <label htmlFor={emailId} className="text-sm font-medium">
          Work email
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          required
          autoComplete="email"
          className="rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      </div>
      {state === "error" && (
        <p role="status" className="text-sm text-danger">
          We could not send the link. Please try again in a minute.
        </p>
      )}
      <button
        type="submit"
        disabled={state === "sending"}
        className="rounded-lg bg-accent px-5 py-3 font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-60"
      >
        {state === "sending" ? "Sending…" : "Email me a sign-in link"}
      </button>
    </form>
  );
}
