# Task Frontmatter Schema

Task notes must remain TaskForge-compatible. Unknown fields should be preserved
when editing.

## Required Core Fields

```yaml
status: open              # open | in-progress | done | cancelled
priority: medium          # highest | high | medium | low
dateCreated: YYYY-MM-DD
due:
start:
tags: []
contexts: []
projects:
topics: []
taskSourceType: taskNotes # taskNotes | inlineTask | calendarEvent
assignee:
```

## Google Integration Fields

```yaml
googleTaskId:
googleTaskListId:
calendarId:
calendarEventId:
calendarStart:
calendarEnd:
timezone:
```

Use configured IDs from `workspace.config.yaml`; never write placeholder IDs to
real task files.

## Vault Promotion Fields

```yaml
vaultPromotionStatus: none # none | proposed | sent | skipped
vaultPromotionReason:
vaultPromotionAt:
vaultPromotionSource:
vaultPromotionNote:
```

`proposed` means this skill found durable knowledge value and created a local
packet. Actual vault writes require an explicit vault skill invocation.

## Status Mapping

| Status | Directory |
| --- | --- |
| `open` | `active/` |
| `in-progress` | `active/` |
| `done` | `archive/` |
| `cancelled` | `archive/` |

## File Naming

Prefer `YYMMDD-project-keywords.md` for file tasks and
`YYMMDD-inline-<hash>.md` for migrated inline tasks.
