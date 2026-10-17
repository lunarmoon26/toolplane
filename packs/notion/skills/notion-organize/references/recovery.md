# Private organization operation record

Use an operation-specific JSON file and/or append-only JSONL event log. This is
local recovery data, not an executable plan or an authorization token.

```json
{
  "operation": "create-destination-and-move",
  "source_ids": ["SOURCE_PAGE_ID"],
  "original_parent_id": "ORIGINAL_PARENT_ID",
  "destination": {
    "title": "Research",
    "id": null,
    "url": null
  },
  "steps": [
    {"step": "source-fetched", "at": "ISO_TIMESTAMP"},
    {"step": "destination-created", "at": "ISO_TIMESTAMP", "id": "NEW_PAGE_ID"},
    {"step": "move-completed", "at": "ISO_TIMESTAMP"},
    {"step": "verified", "at": "ISO_TIMESTAMP", "body_unchanged": true, "children_unchanged": true}
  ]
}
```

Populate destination identity immediately after creation returns. On ambiguous
outcome, append `create-outcome-unknown` or `move-outcome-unknown` rather than
marking the step complete. Keep any async task ID for inspection. Record explicit
user scope separately from the host's actual permission decision; a log entry
does not replace permission evaluation.

## Regression scenarios

- Search returns content matches but no exact destination title: inspect root
  listings before concluding the hub doesn't exist.
- User says "workspace" but means a root page: clarify before moving.
- User says "create one" after the destination was resolved as missing: create
  the proposed hub without repeating the same question.
- Create succeeds and move fails: resume with that destination ID.
- Move succeeds but the response is lost: fresh ancestry prevents a duplicate retry.
- Source already contains appendices: move the parent only and verify the same
  appendix IDs afterward.
