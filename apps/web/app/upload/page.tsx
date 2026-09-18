import { cookies } from "next/headers";
import Link from "next/link";

import { decodeLeadSession, LEAD_SESSION_COOKIE } from "@/lib/lead-session";

// Day 1 placeholder: confirms the lead session. The upload flow replaces this on Day 2.
export default async function UploadPage() {
  const session = decodeLeadSession((await cookies()).get(LEAD_SESSION_COOKIE)?.value);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 sm:px-6">
      {session ? (
        <>
          <p className="text-sm font-medium text-accent">Step 2 of 2</p>
          <h1 className="mt-2 text-3xl font-semibold">Thanks — your details are saved.</h1>
          <p className="mt-4 leading-7 text-muted">
            File upload is not available yet. We will contact you about a manual review.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-3xl font-semibold">Start with a few questions</h1>
          <p className="mt-4 leading-7 text-muted">
            Your upload session has expired or has not started yet.
          </p>
          <Link href="/#get-snapshot" className="mt-6 inline-block font-semibold text-accent underline">
            Go to the form
          </Link>
        </>
      )}
    </main>
  );
}
