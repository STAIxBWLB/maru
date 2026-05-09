---
name: io-gws
description: >
  Public-safe Google Workspace IO connector skill. Use for generic Gmail,
  Google Drive, Google Calendar, and Google Tasks search, read, download,
  create, update, send/draft, and inbox-intake export workflows through a
  configured gws command. Runtime account IDs and service IDs are loaded from
  workspace.config.yaml.
---

# IO GWS

Provide Google Workspace primitives and normalized inbox export. This skill is
not limited to inbox workflows.

## Boot Sequence

1. Find `workspace.config.yaml`.
2. Read `io.providers.gws`.
3. Prefer the configured `gws_binary`; otherwise use `gws` on `PATH`.
4. For inbox imports, pass records and files to `inbox-intake`.

## Capabilities

- Gmail: search, read, attachment download, draft, send
- Drive: search, metadata read, download, upload when configured
- Calendar: event search, create, update
- Tasks: list, create, update, complete

## Rules

- Confirm before sends, uploads, calendar writes, or task writes unless the user
  explicitly asked for that action.
- Use Gmail `Message-ID`, Drive file ID, Calendar event ID, or Task ID as
  dedupe/integration IDs when available.
- Do not route inbox items or extract durable knowledge directly.
- Keep Google IDs in workspace config, receipts, or generated workspace files,
  not in this public skill.

## References

- `references/workspace-config.md` - expected runtime provider keys
