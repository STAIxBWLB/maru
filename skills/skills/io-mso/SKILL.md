---
name: io-mso
description: >
  Public-safe Microsoft 365 IO connector skill. Use for generic Outlook,
  SharePoint, OneDrive, or Microsoft Graph search, read, download, upload,
  draft, send, and inbox-intake export workflows. Runtime accounts, tenant
  details, auth status, and secrets are loaded from workspace.config.yaml and
  local secrets, never from this skill package.
---

# IO MSO

Provide Microsoft 365 primitives and emit normalized inbox items when requested.
This skill owns provider IO only; business routing belongs to `inbox-process`.

## Boot Sequence

1. Find `workspace.config.yaml`.
2. Read `io.providers.mso`.
3. Verify the requested capability is enabled in config.
4. For inbox imports, hand results to `inbox-intake` using the manifest schema.

## Capabilities

- `mail.search`, `mail.read`, `mail.draft`, `mail.send`
- `sharepoint.search`, `sharepoint.download`
- `onedrive.search`, `onedrive.download`
- `file.upload`, `file.share_link` when configured and authorized

## Rules

- Confirm before sending mail, uploading files, or sharing links.
- Prefer source-native dedupe IDs: email message ID, Graph item ID, drive item
  ID, or source URI.
- Store provider metadata in workspace item manifests, not in this skill.
- Do not summarize, route, or create tasks directly.
- If auth or permission is missing, stop with the missing capability and the
  config key to check.

## References

- `references/workspace-config.md` - expected runtime provider keys
