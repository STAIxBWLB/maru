# Workspace Config

The skill must discover `workspace.config.yaml` by walking up from the current
directory. The public skill package never stores real owner or service IDs.

## Expected Shape

```yaml
task_management:
  root: ~/workspace/work/tasks
  timezone: Region/City
  gws_binary: /path/to/gws
  google:
    tasks:
      default_list: default
      lists:
        default:
          id: TASK_LIST_ID
          label: Default
    calendar:
      default_calendar: default
      calendars:
        default:
          id: CALENDAR_ID
          label: Default
  paths:
    tasks: tasks
    active: active
    archive: archive
    backlog: backlog
    calendar: calendar
    references: references
    integration_ids: references/integration-ids.md
    knowledge_pending: _knowledge/pending
```

## Runtime Rules

- Expand `~` before using paths.
- Prefer `task_management.gws_binary`; fall back to `gws` on `PATH`.
- When a configured Google ID is missing, stop before calling Google services.
- Owner metadata may live elsewhere in the same workspace config, but should not
  be copied into public skill files.
