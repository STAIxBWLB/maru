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

## Workflows

### Create a Task

1. Normalize input into title, status, priority, due/start dates, tags,
   contexts, description, and action items.
2. Create a markdown file in `active/` using `templates/task.md`.
3. If Google Tasks is enabled, create a task in the configured default list and
   write `googleTaskId` and `googleTaskListId` back to frontmatter.
4. If the task has a scheduled time or calendar-visible deadline, create a
   calendar event and write `calendarId`, `calendarEventId`, `calendarStart`,
   `calendarEnd`, and `timezone`.
5. Append or update the local integration receipt table.
6. Run the vault-value hook.

### Complete a Task

1. Locate the task by filename, title, Google task ID, or keyword.
2. Set `status: done`, add `done: YYYY-MM-DD`, and move the file to `archive/`.
3. If `googleTaskId` is present, mark the configured Google task completed.
4. Update the integration receipt table.
5. Run the vault-value hook.

### Calendar-Only Item

Use `calendar/` when the user asks for a schedule item with no actionable task.
Create a markdown receipt with `taskSourceType: calendarEvent` and the calendar
extra fields documented in `references/frontmatter-schema.md`.

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
