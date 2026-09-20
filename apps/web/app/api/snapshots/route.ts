import { createSnapshotSchema } from "@cca/domain";

import { log } from "@/lib/log";
import { visitorJsonRoute } from "@/lib/route";
import { createSnapshot } from "@/lib/snapshots";
import { kickWorker } from "@/lib/worker-kick";

/**
 * Starts the free deterministic pass over an uploaded file. No email is known yet and none is sent:
 * the visitor watches the teaser appear on the page, and the report link is emailed only at unlock.
 */
export const POST = visitorJsonRoute("snapshot.create", createSnapshotSchema, async ({ session, body, requestId }) => {
  const result = await createSnapshot(session.tenantId, body);
  log.info("snapshot.created", { requestId, snapshotRunId: result.snapshotRunId, created: result.created });
  // After commit, so the worker can see the job.
  if (result.created) await kickWorker(requestId);
  return { status: result.created ? 201 : 200, body: { snapshotRunId: result.snapshotRunId } };
}, { limit: "snapshot" });
