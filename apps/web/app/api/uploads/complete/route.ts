import { completeUploadSchema } from "@cca/domain";

import { log } from "@/lib/log";
import { leadJsonRoute } from "@/lib/route";
import { completeUpload } from "@/lib/uploads";

export const POST = leadJsonRoute("upload.complete", completeUploadSchema, async ({ session, body, requestId }) => {
  const result = await completeUpload(session, body, requestId);
  log.info("upload.completed", { requestId, sourceFileId: result.sourceFileId, status: result.status });
  // 200 with status "rejected" (not 4xx): the upload itself worked; the content was not a billing CSV.
  return { status: 200, body: result };
}, { limit: "upload" });
