---
name: inbox-intake
description: >
  Public-safe inbox intake skill. Use when importing, staging, deduplicating,
  or normalizing files, messages, exports, transcripts, or connector outputs
  into a workspace inbox item, including channel-root drops such as
  inbox/drop/kakao or inbox/drop/mso. Channel/provider details are read from
  workspace.config.yaml; secrets and account identifiers must not live in this
  skill package.
---

# Inbox Intake

Normalize any external or channel-root input into a file-backed inbox item. This
skill does not summarize, route, extract tasks, or write to a vault.

## Boot Sequence

1. Find `workspace.config.yaml` by walking up from the current directory.
2. Read `inbox`, including `inbox.paths` and `inbox.naming`, and
   `io.providers` from that file.
3. Load `references/manifest-schema.md` before creating or editing a manifest.
4. Use the configured inbox root. Default layout:
   - `drop/<channel>/` for channel-root or connector drop aliases
   - `items/pending/` for new normalized items
   - `items/done/`, `items/failed/`, `items/duplicate/` for terminal states
   - `_state/index.jsonl` for local receipts
   - `manifest.yaml`, `raw/`, `extracted.md`, `summary.md`, and `route.md`
     names come from `inbox.naming`

## Intake Workflow

1. Identify the root source channel from the user request, file path, or
   connector result. If the channel is absent from config, stop and show the
   missing channel key.
2. Group files or records into one logical item. Keep multi-format variants and
   sidecar metadata in the same item.
3. If the source path is under a provider-specific subfolder such as
   `drop/mso/mail/`, store that folder name as `metadata.source_kind`; do not
   change the manifest `channel` away from the root channel.
4. Compute the configured dedupe key. Prefer provider IDs such as message ID or
   file ID; fall back to SHA-256 of attached files.
5. If the dedupe key already exists in `_state/index.jsonl`, create or move the
   item under `items/duplicate/` and record the existing receipt.
6. Create `<inbox.paths.pending>/<item-id>/<inbox.naming.manifest_file>` from
   `templates/manifest.yaml`. Build `<item-id>` with
   `inbox.naming.item_id_template`; the default is `{date}-{channel}-{slug}`.
7. Copy or move raw inputs into the item `inbox.naming.raw_dir` directory
   according to the caller's explicit request. For channel-root imports,
   default to copy. When an inbound attachment filename is Korean, write the
   Korean filename to manifest `source.original_name` (the raw copy MAY keep
   the Korean name because `inbox/items/**` is exempt per
   `_sys/rules/naming-policy.md` L63).
8. Append one JSONL receipt to `_state/index.jsonl`.

## Rules

- Keep original filenames inside `inbox.naming.raw_dir`; normalization happens
  later in `inbox-process`.
- Ignore OS noise such as `.DS_Store`.
- Store channel-specific but non-secret facts under manifest `metadata`.
- Never embed tokens, account IDs, tenant IDs, chat IDs, or private URLs in this
  skill package.
- Do not call external providers directly. Provider fetch/search/download work
  belongs to `io-*` skills.
- Do not write to a vault. If an item has knowledge value, leave it for
  `inbox-process` or an explicit vault skill.

## References

- `references/manifest-schema.md` - normalized inbox item schema
- `references/workspace-config.md` - expected runtime config keys
- `templates/manifest.yaml` - manifest starter template
