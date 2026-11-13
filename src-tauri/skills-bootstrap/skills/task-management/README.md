SKILL.md is the instruction source for this skill. This file is background for maintainers; it holds no directives.

# Task Management background

## Public-safe package

The package carries workflows and schemas only. Identity, calendar IDs, task
list IDs and CLI paths come from the workspace at runtime.

## Frontmatter title

Maru shows a task or calendar receipt by `title -> name -> filename`, so a note
without a frontmatter `title` appears under its raw filename. The body
`# {title}` H1 is there for readability.

## Backref fields stay on create

Maru's `UpdateTaskScheduleFields` payload is `deny_unknown_fields`: it allows
only project, priority, due, calendarStart, calendarEnd and estimateMinutes. Cross-link
backref fields (`source_doc`, `meetingSourcePath`, `relatedMeetings`,
`relatedTasks`, ...) would be rejected there, which is why they belong to the
create frontmatter only.

## Review-mode fields

The `enrichment` object and `conflicts[].conflictKind` were added later as
optional fields. Parsers ignore unknown fields, so existing consumers are
unaffected.
