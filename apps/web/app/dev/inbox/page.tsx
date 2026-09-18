import { notFound } from "next/navigation";
import { connection } from "next/server";

import { readDevInbox } from "@/lib/email";
import { serverEnv } from "@/lib/env";

/** Local development only: shows emails the app "sent" (magic links). 404 in any hosted environment. */
export default async function DevInboxPage() {
  await connection(); // always read the inbox at request time, never at build time
  const env = serverEnv();
  if (env.EMAIL_DRIVER !== "dev-inbox" || (env.APP_ENV !== "development" && env.APP_ENV !== "test")) {
    notFound();
  }
  const messages = await readDevInbox();
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6">
      <p className="text-sm font-medium text-danger">Development only</p>
      <h1 className="mt-1 text-2xl font-semibold">Dev inbox</h1>
      <p className="mt-2 text-sm text-muted">Emails are written here instead of being sent.</p>
      {messages.length === 0 ? (
        <p className="mt-8 text-sm text-muted">No messages yet.</p>
      ) : (
        <ul className="mt-8 space-y-4">
          {messages.map((m) => (
            <li key={m.id} className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted">
                {m.sentAt} · to <span data-testid="inbox-to">{m.to}</span>
              </p>
              <p className="mt-1 font-medium">{m.subject}</p>
              <pre className="mt-3 overflow-x-auto text-xs leading-5 whitespace-pre-wrap">
                {m.text.split(/(https?:\/\/\S+)/).map((part, i) =>
                  /^https?:\/\//.test(part) ? (
                    <a key={i} href={part} className="text-accent underline">
                      {part}
                    </a>
                  ) : (
                    part
                  ),
                )}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
