# Anchor Integration Contract

Anchor can treat the configured task root as a local-first data source.

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

Anchor should display these when present:

- `title` — display name. Anchor resolves the shown label as
  `title -> name -> filename`, so notes without a `title` fall back to their
  raw filename. A workspace-wide label mode (`title` / `filename` / both)
  controls whether the UI shows the title, the filename, or both together.
- `status`, `priority`, `due`, `start`, `done`
- `tags`, `contexts`, `projects`, `topics`
- `googleTaskId`, `googleTaskListId`
- `calendarId`, `calendarEventId`, `calendarStart`, `calendarEnd`, `timezone`
- `vaultPromotionStatus`, `vaultPromotionReason`

## Write Behavior

Anchor should update the markdown file first, then let an agent or explicit
integration action update Google services. The file remains the local source of
truth.
