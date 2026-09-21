# ADR 0005: What happened to last month's findings

Status: accepted (2026-09-21).

## Context

`docs/positioning.md` argues that the durable product is not the report but the **memory of what was
decided**, because it is the only mechanism by which anyone — including us — can attribute an outcome
to the thing. Cost Explorer cannot do it: it has no idea what you decided. A report that cannot say
"you were told to look at ECS, and here is what it did" is a monthly artifact, not a service.

Three things stood in the way.

**Findings had no identity that survived a file.** `evidence_id` was
`ev_{file_sha256[:12]}_{kind}_{dimension}_{label_hash}_{YYYYMM}` — both the file hash and the month
change next month, so the same subject produced a different id every time.

**Workspaces fragment.** The visitor cookie lives 24 hours (uploads are anonymous by design, ADR
0002), so a customer returning a month later gets a *new* tenant. Their verified email is the only
thread between the two, and RLS forbids a single query spanning both.

**Nothing compared two runs.** Every read path was scoped to one run.

## Decision

**A finding's subject is `finding_key = {kind}_{dimension}_{label_hash}`** — what the finding is
*about*, with no file and no month in it (`detectors/core.py`). `evidence_id` keeps its shape with
this as the stable middle, so nothing that depended on it changed. It is persisted with `dimension`
and `label` on `snapshot_finding` (migration 0013), indexed by `(tenant_id, finding_key)`.

The label is hashed rather than stored in the key, so the key carries no customer text. A service
renamed between exports starts a new subject, which is honest: we cannot prove the two are the same
thing.

**The comparison runs at read time, across every workspace the viewer owns** (`lib/history.ts`).
That is what makes the fragmentation a non-issue: `getViewer` already returns `tenantIds` for a
verified email, each workspace is read under its own RLS context, and the results are merged in
application code — the same shape `listSnapshots` already uses. No migration of old tenants, no
cross-tenant SQL, and nothing to do at upload time.

**The previous report is the most recent one about an earlier month**, not the previously uploaded
file. Upload order is not billing order: someone can upload August and then go back for July, and
July is not news about August.

Each carried subject is classified from the customer's own numbers: **grew** (up more than 2%),
**shrank**, **unchanged**, or **resolved** (it was a finding, and this month it is not).

## What the report says

A "Since June 2026" section above the findings, listing what became of each one, plus a count of
what is new. It states outcomes and never claims credit for them — the copy says so explicitly:
*"whether anything here changed because of the report is not something a bill can show."* That
sentence is asserted by an e2e test, because it is the one claim the loop could tempt us into.

## Consequences

* The first snapshot shows no history section at all, which is correct and also means the value of
  the product is only visible on the second upload. That is worth knowing for how we ask people back.
* Matching is by exact label hash. A service renamed by AWS, or an export switched from one grouping
  to another, breaks the match and shows the old finding as resolved and the new one as new. Visible
  and wrong-ish, but the alternative is guessing that two differently-named things are the same.
* Findings recorded before migration 0013 have no `finding_key`, so the loop starts from the next
  upload. Nothing backfills, because the label is not recoverable from an old `evidence_id`.
* `fixtures/icp/17a` and `17b` are a returning customer: EC2 climbs in both months (carries), S3's
  jump does not repeat (resolves), NAT gateway appears (new).
