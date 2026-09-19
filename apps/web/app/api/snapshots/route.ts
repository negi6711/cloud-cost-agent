import { createSnapshotSchema } from "@cca/domain";

import { log } from "@/lib/log";
import { sendResultLink } from "@/lib/result-link";
import { leadJsonRoute } from "@/lib/route";
import { createSnapshot } from "@/lib/snapshots";
import { kickWorker } from "@/lib/worker-kick";

export const POST = leadJsonRoute("snapshot.create", createSnapshotSchema, async ({ session, body, requestId }) => {
  const result = await createSnapshot(session.tenantId, body);
  log.info("snapshot.created", { requestId, snapshotRunId: result.snapshotRunId, created: result.created });
  // After commit, so the worker can see the job. Only for a new run: repeats must not re-send email.
  if (result.created) {
    await kickWorker(requestId);
    await sendResultLink(session.tenantId, session.leadId, result.snapshotRunId, requestId);
  }
  return { status: result.created ? 201 : 200, body: { snapshotRunId: result.snapshotRunId } };
}, { limit: "snapshot" });
