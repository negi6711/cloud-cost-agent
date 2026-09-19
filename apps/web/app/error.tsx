"use client";

/** Route-level error boundary: a generic message only; details stay in the server logs. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 sm:px-6">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="mt-3 text-muted">Please try again. If it keeps happening, reply to your snapshot email.</p>
      <button type="button" onClick={reset} className="mt-6 rounded-lg bg-accent px-4 py-2 font-semibold text-accent-foreground">
        Try again
      </button>
    </main>
  );
}
