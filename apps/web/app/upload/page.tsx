import { TYPESAFE_DISCLOSURE } from "@cca/domain";

import { UploadFlow } from "@/components/upload-flow";

/**
 * The whole flow lives here: upload, then the figures we calculate from the file, then the email
 * gate. No sign-in and no form stand in front of the upload.
 */
export default function UploadPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-semibold">Upload your AWS billing export</h1>
      <p className="mt-4 leading-7 text-muted">
        In AWS Cost Explorer, choose a monthly view grouped by <strong>Service</strong> covering at
        least two full months, then use <strong>Download as CSV</strong>. We check the file and
        calculate your figures straight away — no email needed to see them.
      </p>
      <div className="mt-8">
        <UploadFlow disclosure={TYPESAFE_DISCLOSURE} />
      </div>
      <p className="mt-6 text-xs leading-5 text-muted">
        Read-only: we never ask for AWS credentials and never change your infrastructure. If you do not
        ask for the full report, the file is deleted within 7 days; otherwise it is kept for 30 days
        unless you delete it sooner.
      </p>
    </main>
  );
}
