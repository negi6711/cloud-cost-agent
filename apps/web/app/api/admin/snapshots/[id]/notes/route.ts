import { adminNoteSchema } from "@cca/domain";

import { addSnapshotNote } from "@/lib/admin";
import { adminJsonRoute } from "@/lib/admin-route";

export const POST = adminJsonRoute("admin.snapshot_note", adminNoteSchema, async ({ id, body, adminEmail }) => {
  const noteId = await addSnapshotNote(id, body.body, adminEmail);
  return { status: 201, body: { noteId } };
});
