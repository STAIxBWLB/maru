# Google CLI Cheatsheet

Examples use placeholders. Resolve real IDs from `workspace.config.yaml`.

## List Tasks

```bash
GWS tasks tasks list --params '{"tasklist":"TASK_LIST_ID"}'
```

## Create Task

```bash
GWS tasks tasks insert \
  --params '{"tasklist":"TASK_LIST_ID"}' \
  --json '{"title":"Task title","notes":"File: tasks/active/YYMMDD-task.md","due":"YYYY-MM-DDT00:00:00.000Z"}'
```

## Complete Task

```bash
GWS tasks tasks patch \
  --params '{"tasklist":"TASK_LIST_ID","task":"TASK_ID"}' \
  --json '{"status":"completed"}'
```

## Create Timed Calendar Event

```bash
GWS calendar events insert \
  --params '{"calendarId":"CALENDAR_ID"}' \
  --json '{"summary":"Event title","start":{"dateTime":"YYYY-MM-DDTHH:MM:SS+09:00","timeZone":"TIMEZONE"},"end":{"dateTime":"YYYY-MM-DDTHH:MM:SS+09:00","timeZone":"TIMEZONE"}}'
```

## Create All-Day Calendar Event

```bash
GWS calendar events insert \
  --params '{"calendarId":"CALENDAR_ID"}' \
  --json '{"summary":"Event title","start":{"date":"YYYY-MM-DD"},"end":{"date":"YYYY-MM-DD_PLUS_ONE"}}'
```
