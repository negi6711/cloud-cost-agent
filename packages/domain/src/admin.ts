import { LEAD_STATUSES } from "@cca/config";
import { z } from "zod";

export const adminLeadStatusSchema = z.object({ status: z.enum(LEAD_STATUSES) });
export type AdminLeadStatusInput = z.infer<typeof adminLeadStatusSchema>;

export const adminNoteSchema = z.object({ body: z.string().trim().min(1, "Write a note first.").max(2000) });
export type AdminNoteInput = z.infer<typeof adminNoteSchema>;

export const LEAD_STATUS_LABELS: Record<(typeof LEAD_STATUSES)[number], string> = {
  new: "New",
  needs_clarification: "Needs clarification",
  snapshot_sent: "Snapshot sent",
  pilot_requested: "Pilot requested",
  not_qualified: "Not qualified",
  follow_up_later: "Follow up later",
};
