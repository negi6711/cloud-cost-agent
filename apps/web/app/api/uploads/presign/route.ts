import { presignUploadSchema } from "@cca/domain";

import { leadJsonRoute } from "@/lib/route";
import { presignUpload } from "@/lib/uploads";

export const POST = leadJsonRoute("upload.presign", presignUploadSchema, async ({ session, body }) => {
  const result = await presignUpload(session, body);
  return { status: 200, body: result };
});
