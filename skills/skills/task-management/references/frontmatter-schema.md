# Task Frontmatter Schema

Task notes must remain TaskForge-compatible. Unknown fields should be preserved
when editing.

## Required Core Fields

```yaml
title: Human-readable task title   # required; how the task is shown in Anchor
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

## Display Title

Anchor resolves the title shown in lists and the calendar as
`title -> name -> filename`. Always write a human-readable `title` to
frontmatter; the body `# {title}` H1 alone is **not** used for display, so a
missing `title` makes the note appear as its raw filename.

## File Naming

Prefer `YYMMDD-project-keywords.md` for file tasks and
`YYMMDD-inline-<hash>.md` for migrated inline tasks. The filename is a stable
identifier, not the display title — keep a friendly `title` in frontmatter.
