---
name: io-mso
description: >
  Public-safe Microsoft 365 IO connector skill. Use for generic Outlook mail and
  calendar, OneDrive, SharePoint, Teams chat, OneNote, Planner, To Do, or
  Microsoft Graph search, read, download, upload, draft, send, and inbox-intake
  export workflows through the m365 CLI. Runtime accounts, tenant details, auth
  status, and secrets are loaded from workspace.config.yaml and local secrets,
  never from this skill package.
---

# IO MSO

Provide Microsoft 365 primitives and emit normalized inbox items when requested.
This skill owns provider IO only; business routing belongs to `inbox-process`.

## Boot Sequence

1. Find `workspace.config.yaml`.
2. Read `io.providers.mso`.
3. Prefer the configured `command`; otherwise use `m365` on `PATH`.
4. Verify the requested capability is enabled in config.
5. For inbox imports, hand results to `inbox-intake` using the manifest schema.

## Capabilities

- Outlook mail: `mail.search`, `mail.read`, `mail.move`, `mail.draft`, `mail.send`
- Outlook mailbox: `mailbox.settings.read`, `mailbox.settings.write`
- Outlook calendar: `calendar.read`, `calendar.write`
- OneDrive: `onedrive.list`, `onedrive.download`, `onedrive.upload`
- SharePoint: `sharepoint.search`, `sharepoint.download`, `sharepoint.upload`
- Files: `file.upload`, `file.share_link` when configured and authorized
- Teams (personal chat only): `teams.chat.read`, `teams.chat.send`,
  `teams.directory.read`
- OneNote: `onenote.read`, `onenote.write`
- Tasks: `tasks.planner.read`, `tasks.planner.write`, `tasks.todo.read`,
  `tasks.todo.write`

The exact command per operation is in `references/command-map.md`. Read it
instead of guessing: several plausible names do not exist (`outlook mailbox
list`, `onedrive file list`), and `m365 onedrive list` returns tenant OneDrive
sites rather than the signed-in user's files.

## Scope Preflight

Every operation needs a delegated scope, and most of them are not granted by
default. Check before running, not after failing.

1. Look up the operation in `references/command-map.md` and read its scope.
2. Compare with the granted scopes in the workspace's local auth status.
3. If a scope is missing, **do not attempt the command.** Stop and report the
   missing scope name plus the config key to check.

`Access is denied` is **not** a failed login, so do not re-run login and do not
retry the command. It has two distinct causes, and they need different answers:

- **Missing token scope** — the delegated scope in the map was never granted, or
  the token predates the grant. Report the scope name and the config key.
- **Resource-level authorization** — the scope is present but the signed-in user
  has no access to that particular site, team, chat, plan, or mailbox. Report it
  as a membership/ACL problem on the named resource, not as a scope gap.

Separate them before reporting: check whether the granted-scope list already
contains the scope the map names. If it does, the failure is resource-level.

Scopes marked `inferred` in the map were not confirmed against the CLI. Say so
when one gates a request that needs tenant-admin consent.

The `capabilities` list in `workspace.config.yaml` is a *declared surface*. The
granted-scope source of truth is the workspace's local auth status; when the two
disagree, the auth status wins.

## Runtime Notes

- Driven through the CLI-for-M365 MCP server, shell metacharacters are blocked,
  so a URL carrying `$top` or `$filter` only works from a direct shell
  invocation. Prefer a native command; use `m365 request` from a real shell when
  there is none.
- In that shell, **single-quote the URL**. Double quotes let the shell expand
  `$top` / `$filter` / `$select` to nothing, so the request silently loses its
  OData parameter.
- `m365 outlook message list` has no paging flag and walks the whole folder
  (120 s+). List through `m365 request --url` with `$top`.
- A token issued before a scope was granted does not carry it. After a consent
  change, re-authenticate before concluding the scope is still missing.

## Rules

- Confirm before sending mail, uploading files, sending chat messages, writing
  calendar or task items, or sharing links.
- Prefer source-native dedupe IDs: email message ID, Graph item ID, drive item
  ID, chat ID plus message ID, or source URI.
- Store provider metadata in workspace item manifests, not in this skill.
- Do not summarize, route, or create tasks directly.
- If auth or permission is missing, stop with the missing capability and the
  config key to check.

## References

- `references/command-map.md` - product family x operation, command, and scope
- `references/workspace-config.md` - expected runtime provider keys
