---
name: task-management
description: >
  Public-safe task management skill for file-backed tasks with Google Tasks and
  Google Calendar integration. Use when the user asks to create, update,
  complete, review, schedule, or summarize tasks, todos, deadlines, reminders,
  or calendar-linked work items. Runtime owner details and service IDs must be
  loaded from workspace.config.yaml and local task references, never from this
  skill package.
---

# Task Management

Manage workspace-local tasks backed by markdown files, Google Tasks, and Google
Calendar. This skill is public-safe: it contains workflows and schemas only.
Workspace-specific identity, calendar IDs, task list IDs, and CLI paths must be
loaded at runtime.

## Boot Sequence

1. Find `workspace.config.yaml` by walking up from the current directory.
2. Read `task_management` from that file. If it is absent, read
   `references/workspace-config.md` and ask for the missing workspace-local
   values before writing tasks.
3. Read the local integration receipt file configured by
   `task_management.paths.integration_ids`.
4. Use the configured task root. Default layout:
   - `active/` for open and in-progress task notes
   - `archive/` for done and cancelled task notes
   - `backlog/` for deferred task notes
   - `calendar/` for calendar-only items
   - `_knowledge/pending/` for vault-promotion proposals
5. If `task_management.context_enrichment` is true, read `ssot.context_enrichment`
   and the `context.*` lookup paths it names; apply the procedure when creating
   tasks (entity resolution + context bundle + cross-link backrefs).

## Core Rules

- Keep the task file as the local source of truth.
- Use Google Tasks for task scheduling and completion receipts.
- Use Google Calendar only for dated meetings, deadlines, and time blocks.
- Keep all generated task files TaskForge-compatible. Load
  `references/frontmatter-schema.md` before changing the schema.
- Do not embed personal values in skill files. Use `workspace.config.yaml`.
- Do not write to a vault directly. If a task has durable knowledge value,
  create or update only a local promotion proposal and tell the user which vault
  skill to run.
- Operational task logging stays work-local: append timeline lines only to
  `.anchor/tasks-log.md`. The `vault/log.md` `TASK` event is promoted later by
  vault-sync or an explicit vault skill — never MCP-append to the vault
  (context-enrichment §6).

## Anchor Run Contract

When Anchor runs this skill in background/review mode (the prompt asks for
proposals only), do not write files, mutate Google Tasks/Calendar, or run
follow-up skills during the run. Read-only Google Tasks/Calendar lookup is
allowed for conflict checks, existing ID reconciliation, and sync preview
quality. Google Tasks/Calendar mutations happen only later, through this
skill's approved-execution path — never as Anchor file writes. Terminal and
direct-CLI use of this skill is unchanged by this section.

1. Emit concise human-readable progress logs while working. Prefix major
   progress logs with stable phase markers so Anchor can render stepwise status:
   - `[phase:source]` after the schedule/task source text or files are read.
   - `[phase:normalize]` while resolving title, dates, timezone, project, and
     checking the configured calendar/task list for conflicts.
   - `[phase:draft]` while drafting the task/calendar markdown.
   - `[phase:proposal]` when preparing the `anchor_skill_proposal_v1` block.
   - `[phase:review]` when preparing the `anchor_task_review_v1` block.
   - Include exactly one phase marker per line, at the start of the line (after
     the timestamp). For errors, prepend `ERROR:` or use `[phase:error]`.
2. Return exactly one `anchor_skill_proposal_v1` JSON object with the local
   markdown file writes:
   - Schedule-from-text run: the new task note under `active/` and/or a
     calendar receipt under `calendar/`.
   - Sync run: `replace` operations that update only the ID/schedule frontmatter
     (`googleTaskId`, `googleTaskListId`, `calendarId`, `calendarEventId`,
     `calendarStart`, `calendarEnd`, `timezone`) on existing task files. Do not
     add create-only backref fields in a sync proposal.
3. Return exactly one `anchor_task_review_v1` JSON object for user confirmation:

```json
{
  "schemaVersion": "anchor_task_review_v1",
  "summary": "short review summary; for sync, name which Google side-effects run after approval",
  "taskDetails": { "title": "…", "status": "active", "priority": "medium", "due": "YYYY-MM-DD or null", "start": "ISO or null", "project": "… or null" },
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
  "followups": [ { "skill": "vault-extract", "title": "…", "prompt": "proposal-only follow-up", "reason": "why", "selected": false } ]
}
```

Allowed follow-up skills are `vault-extract`, `vault-connect`, and
`meeting-notes` (never `task-management` itself). Follow-ups must be proposals
for the user to review. The `enrichment` object and the
`conflicts[].conflictKind` field are additive and optional — populate them only
from resolved data and omit or null them otherwise. Parsers ignore unknown
fields, so existing consumers are unaffected.

## Workflows

### Create a Task

1. Normalize input into title, status, priority, due/start dates, tags,
   contexts, description, and action items.
2. **Context enrichment (Vault-First T2).** When `context_enrichment` is true,
   resolve `projects` and `assignee` per the context-enrichment procedure §2 and
   assemble the bundle §3 (prior decisions, sibling open tasks, related
   meetings, matching calendar events). Set the additive cross-link fields **on
   the CREATE frontmatter only** — `projects`/`topics` from the registry,
   `source_doc`/`meetingSourcePath` when the task came from a meeting,
   `relatedMeetings`/`relatedTasks` when resolved — and inject a
   `## 관련 컨텍스트` block summarizing the bundle. Emit a wiki-link only for
   resolved entities. **Never add these backref fields to a later
   schedule-update payload** — Anchor `UpdateTaskScheduleFields` is
   `deny_unknown_fields` (allows only project/priority/due/calendarStart/
   calendarEnd/estimateMinutes); they belong to create frontmatter only.
3. Create a markdown file in `active/` using `templates/task.md`. Always write a
   human-readable `title` to frontmatter — Anchor shows the note by
   `title -> name -> filename`, so a missing `title` makes it appear as the raw
   filename. The body `# {title}` H1 is for readability only and is not used for
   display.
4. If Google Tasks is enabled, create a task in the configured default list and
   write `googleTaskId` and `googleTaskListId` back to frontmatter.
5. If the task has a scheduled time or calendar-visible deadline, first search
   the configured calendar for conflicts (io-gws `calendar.event.search`) and
   warn the user about overlaps; then create a calendar event and write
   `calendarId`, `calendarEventId`, `calendarStart`, `calendarEnd`, and
   `timezone`.
6. Append or update the local integration receipt table, and append one `TASK`
   line to the work-local `.anchor/tasks-log.md` (never the vault).
7. Run the vault-value hook.

### Complete a Task

1. Locate the task by filename, title, Google task ID, or keyword.
2. Set `status: done`, add `done: YYYY-MM-DD`, and move the file to `archive/`.
3. If `googleTaskId` is present, mark the configured Google task completed.
4. Update the integration receipt table.
5. Run the vault-value hook.

### Calendar-Only Item

Use `calendar/` when the user asks for a schedule item with no actionable task.
Create a markdown receipt with `taskSourceType: calendarEvent`, a human-readable
`title` in frontmatter (so it does not show as the raw filename), and the
calendar extra fields documented in `references/frontmatter-schema.md`.

### Vault-Value Hook

After create, update, or completion, check whether the item contains durable
knowledge value:

- a decision or explicit commitment
- a project risk, dependency, or policy change
- a reusable lesson, workflow, or methodology
- a relationship or organization fact that should be remembered

If yes, write or update a local packet in `_knowledge/pending/`, set
`vaultPromotionStatus: proposed`, and tell the user the candidate is ready for
explicit vault promotion. Do not create, edit, or append to vault notes from this
skill.

## References

- `references/workspace-config.md` - runtime configuration keys
- `references/frontmatter-schema.md` - file schema
- `references/anchor-integration.md` - app-facing contract
- `references/google-cli-cheatsheet.md` - Google CLI examples
- `references/integration-ids.template.md` - local receipt template
- `ssot.context_enrichment` (`_sys/rules/context-enrichment.md`) - entity
  resolution + context bundle + cross-link contract (applied on create when
  `task_management.context_enrichment` is true)
