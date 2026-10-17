---
name: notion-organize
description: Organize Notion pages by creating destinations and moving page trees safely. Use for root-level research hubs, filing pages under projects, reorganizing subpages, or recovering interrupted create-and-move operations.
---

# Organize Notion pages

Load `toolplane-integrations` first and use the registered Notion capabilities.

## Resolve intent without repeated questions

1. Identify the source by exact URL/ID and fetch it fresh. Record its original
   parent, child-page IDs and body before changing anything.
2. Distinguish a **Notion workspace**, **teamspace**, **root-level page**, and
   **local folder**. Ask once if ambiguity changes where content moves or who
   can access it. A root-level page is not a new Notion workspace.
3. Resolve the destination: search distinctive title words, compare returned
   titles exactly, and fetch candidates. Search may match content or individual
   words; a result is not automatically the requested destination.
4. Before declaring a root destination missing, inspect the relevant private,
   shared, or teamspace listings with their live cursor schema. Follow all pages;
   an empty page with a cursor is not the end. Disclose access limits.
5. If the destination is missing, offer to create it. When the user says
   "create one" after that offer, treat it as authorization for that destination
   in the established plan; don't ask the same scope question again.

## Plan and execute

- Briefly state the source and destination and whether creation is necessary.
  Confirm the exact set and access implications before bulk or destructive work.
- Execute writes through Toolplane and its single-use per-call approval gate.
  User intent does not remove the permission gate. Don't substitute direct
  MCPorter shell calls, hard-coded session IDs, synthetic approvals, or a
  standalone mutation script that skips host permission evaluation.
- Inspect live schemas. For a named **private workspace-root** page, create a
  page with the desired title and no parent. Do not use a made-up workspace
  parent object. A teamspace root needs its real teamspace ID and access.
- If the next operation needs the created ID immediately, synchronous creation
  (`allow_async: false`, if supported) is appropriate. Otherwise follow the task
  to completion before moving anything.
- Save the new destination's returned ID/URL immediately, before the move.
- Move the **parent page once** into the resolved destination. Its existing
  descendants follow it; do not move each child separately or recreate content.
- Never move a page into itself or one of its descendants. Don't attempt a
  cross-workspace move using a same-workspace parent ID.

## Verify

Fetch both the moved page and destination. Verify:

1. The source's new immediate parent is the intended destination.
2. The destination lists the moved page.
3. Source body and child-page IDs are unchanged. Compare bodies, not whole fetch
   wrappers, which include timestamps and ancestry.
4. If any check fails, stop and report the exact uncertainty. Don't automatically
   roll back or retry a mutation with an unknown outcome.

Finish with the destination link, moved page count, whether descendants were
preserved, and any incomplete verification.

## Recovery

Keep a private operation record in `.local/operations/` outside the skill source.
Write each completed step at event time, not only at the end. Record source IDs,
original parent, destination ID/URL, requested scope, returned async task IDs and
verification outcome. Never store tokens or signed URLs. See
[references/recovery.md](references/recovery.md) for a portable record shape.

- **Create succeeded, move failed:** reuse the recorded destination; don't create
  another hub.
- **Create timed out:** search/list and verify a candidate or async task before
  deciding whether a new create is safe. A matching title alone is insufficient.
- **Move timed out:** fetch current ancestry before deciding whether to retry.
- **Scope changed:** get the user's new direction; don't silently reuse an old plan.
