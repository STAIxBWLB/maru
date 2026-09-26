# Workspace Config

```yaml
io:
  providers:
    mso:
      skill: io-mso
      enabled: true
      auth_mode: workspace-local
      command: m365
      accounts: {}
      secrets: {}
      capabilities:
        - mail.search
        - mail.read
        - mail.move
        - mail.draft
        - mail.send
        - mailbox.settings.read
        - calendar.read
        - onedrive.list
        - onedrive.download
        - sharepoint.search
        - sharepoint.download
        - teams.chat.read
        - teams.directory.read
        - onenote.read
        - tasks.planner.read
        - tasks.todo.read
```

The list above is the read-oriented starting set. Add write capabilities
(`mail.send`, `*.upload`, `teams.chat.send`, `*.write`) only once the matching
delegated scope is actually granted — see `command-map.md` for which scope each
one needs.

`capabilities` is a **declared surface**, not evidence of consent. The granted
scopes live in the workspace's local auth status, and that is what
Scope Preflight compares against; the two can drift.

Account labels, tenant details, auth status paths, and secrets references are
workspace-local values. Do not copy them into the public skill package.
