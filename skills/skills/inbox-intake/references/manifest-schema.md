# Inbox Item Manifest Schema v1

Every normalized inbox item has exactly one `manifest.yaml`.

```yaml
schema: inbox-item/v1
id: YYMMDD-channel-slug
status: pending
channel: arc
provider: local
kind: file
received_at: YYYY-MM-DDTHH:MM:SS+09:00
dedupe_key: sha256:<digest>
source:
  uri: ""
  original_name: ""
  message_id: ""
  thread_id: ""
files:
  - path: raw/original.ext
    role: primary
    mime: application/octet-stream
    sha256: "<digest>"
metadata:
  source_kind: ""
  processing_context: ""
  processing_hints: {}
```

## Required Fields

| Field | Rule |
|---|---|
| `schema` | Must be `inbox-item/v1`. |
| `id` | Stable local ID, usually `YYMMDD-channel-slug`. |
| `status` | `pending`, `done`, `failed`, or `duplicate`. |
| `channel` | Configured `inbox.channels` key. |
| `provider` | `local`, `mso`, `gws`, `telegram`, or another configured provider slug. |
| `kind` | `file`, `message`, `attachment`, `document`, `transcript`, `data`, or `bundle`. |
| `received_at` | Local timestamp with timezone. |
| `dedupe_key` | Provider ID or `sha256:<digest>`. |
| `files` | Array of local files relative to the item directory. |

`channel` is always the root `inbox.channels` key. For source-specific detail,
such as `drop/mso/mail/` or `drop/kakao/files/`, use `metadata.source_kind`
instead of creating fine-grained channel names.

## Dedupe Keys

Prefer source-native identifiers when available:

- email/message: RFC 5322 message ID or provider message ID
- cloud document: drive item ID, file ID, or source URI
- chat message: chat ID plus message ID or export row ID
- channel-root local file: SHA-256 digest of primary file

If a source ID might expose private account details, store it only in the
workspace item manifest, never in this public skill package.

## File Roles

Use `primary` for the main artifact. Use `attachment`, `sidecar`, `metadata`,
`preview`, or `transcript` for supporting files.
