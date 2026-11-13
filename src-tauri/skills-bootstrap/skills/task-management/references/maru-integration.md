# Maru Integration Contract

Maru can treat the configured task root as a local-first data source.

## Directories

```text
tasks/
├── active/
├── archive/
├── backlog/
├── calendar/
├── references/
│   └── integration-ids.md
└── _knowledge/
    └── pending/
```

## Parsing Rules

- Read markdown files with YAML frontmatter.
- Preserve unknown frontmatter keys.
- Treat `active/`, `archive/`, `backlog/`, and `calendar/` as app-visible.
- Treat `_knowledge/` and `_migration/` as operational folders.
- Use `taskSourceType` to distinguish file tasks, migrated inline tasks, and
  calendar-only items.

## App Fields

Maru should display these when present:

- `title` — display name. Maru resolves the shown label as
  `title -> name -> filename`, so notes without a `title` fall back to their
  raw filename. A workspace-wide label mode (`title` / `filename` / both)
  controls whether the UI shows the title, the filename, or both together.
- `status`, `priority`, `due`, `start`, `done`
- `tags`, `contexts`, `projects`, `topics`
- `googleTaskId`, `googleTaskListId`
- `calendarId`, `calendarEventId`, `calendarStart`, `calendarEnd`, `timezone`
- `vaultPromotionStatus`, `vaultPromotionReason`
- `source_doc`, `meetingSourcePath`, `relatedMeetings`, `relatedTasks` — backref
  links (set on create; preserve as unknown keys, never require)

## Background and Review Runs

Read before a background/review-mode run. The write limits stay in SKILL.md
*Maru Run Contract*.

Prefix major progress logs with stable phase markers so Maru can render
stepwise status:

- `[phase:source]` after the schedule/task source text or files are read.
- `[phase:normalize]` while resolving title, dates, timezone, project, and
  checking the configured calendar/task list for conflicts.
- `[phase:draft]` while drafting the task/calendar markdown.
- `[phase:proposal]` when preparing the `maru_skill_proposal_v1` block.
- `[phase:review]` when preparing the `maru_task_review_v1` block.
- Include exactly one phase marker per line, at the start of the line (after
  the timestamp). For errors, prepend `ERROR:` or use `[phase:error]`.

The `maru_task_review_v1` object:

```json
{
  "schemaVersion": "maru_task_review_v1",
  "summary": "short review summary; for sync, name which Google side-effects run after approval",
  "taskDetails": { "title": "...", "status": "active", "priority": "medium", "due": "YYYY-MM-DD or null", "start": "ISO or null", "project": "... or null" },
  "fields": [ { "label": "raw title", "normalized": "clean title", "note": "why", "required": true } ],
  "schedule": [ { "label": "tomorrow 3pm", "normalized": "2026-06-10T15:00+09:00", "note": "Asia/Seoul", "required": true } ],
  "conflicts": [ { "label": "overlaps existing event", "normalized": "keep / move / ignore", "note": "calendar clash detail", "required": true, "conflictKind": "calendar" } ],
  "uncertainties": [ { "label": "uncertain owner", "normalized": "best guess", "note": "needs user check", "required": true } ],
  "enrichment": {
    "project": "[[note]] or null",
    "relatedTasks": ["[[task-note]]"],
    "relatedMeetings": ["[[meeting-note]]"],
    "calendarLink": { "calendarId": "id-or-null", "calendarEventId": "id-or-null" },
    "resolvedAssignee": "canonical or null"
  },
  "followups": [ { "skill": "vault-extract", "title": "...", "prompt": "proposal-only follow-up", "reason": "why", "selected": false } ]
}
```

The `enrichment` object and the `conflicts[].conflictKind` field are additive
and optional: populate them only from resolved data and omit or null them
otherwise. Parsers ignore unknown fields.

## Write Behavior

Maru should update the markdown file first, then let an agent or explicit
integration action update Google services. The file remains the local source of
truth.
