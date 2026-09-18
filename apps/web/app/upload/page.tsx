import { TYPESAFE_DISCLOSURE } from "@cca/domain";
import { cookies } from "next/headers";
import Link from "next/link";

import { UploadFlow } from "@/components/upload-flow";
import { decodeLeadSession, LEAD_SESSION_COOKIE } from "@/lib/lead-session";

export default async function UploadPage() {
  const session = decodeLeadSession((await cookies()).get(LEAD_SESSION_COOKIE)?.value);

  if (!session) {
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-semibold">Start with a few questions</h1>
        <p className="mt-4 leading-7 text-muted">Your upload session has expired or has not started yet.</p>
        <Link href="/#get-snapshot" className="mt-6 inline-block font-semibold text-accent underline">
          Go to the form
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 sm:px-6">
      <p className="text-sm font-medium text-accent">Step 2 of 2</p>
      <h1 className="mt-2 text-3xl font-semibold">Upload your AWS billing export</h1>
      <p className="mt-4 leading-7 text-muted">
        In AWS Cost Explorer, choose a monthly view grouped by <strong>Service</strong> covering at
        least two full months, then use <strong>Download as CSV</strong>. We check the file, calculate
        the facts, and prepare your snapshot.
      </p>
      <div className="mt-8">
        <UploadFlow disclosure={TYPESAFE_DISCLOSURE} />
      </div>
      <p className="mt-6 text-xs leading-5 text-muted">
        Read-only: we never ask for AWS credentials and never change your infrastructure. The raw file
        is kept for 30 days unless you delete it sooner.
      </p>
    </main>
  );
}
