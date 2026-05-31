---
name: share-outbox
description: >
  Public-safe outgoing file preparation skill. Use when preparing files to send
  or share externally with Korean filenames plus an author suffix and timestamp,
  staging share-ready copies in a configured outbox/shared folder, replacing
  draft/final/version suffixes from inbox originals or templates, and recording
  local share receipts. Runtime author suffixes and output paths must be loaded
  from workspace.config.yaml, never stored in this skill package.
---

# Share Outbox

Prepare share-ready file copies for external sending. This skill does not send
email, upload to cloud storage, create public links, or write to a vault.

## Boot Sequence

1. Find `workspace.config.yaml` by walking up from the current directory.
2. Read `share_outbox` from that file. If it is missing, read
   `references/workspace-config.md` and ask for the missing workspace-local
   values before preparing files.
3. If the source is an inbox item, read its `manifest.yaml` to preserve the
   original filename or template filename.
4. Load `references/filename-rules.md` before deciding the outgoing title.

## Workflow

1. Identify the source file that will be sent. Use the actual file extension of
   that source for the outgoing copy.
2. Resolve the Korean title:
   - Prefer an explicit user-provided Korean title.
   - Else use the inbox manifest `source.original_name`, raw source filename,
     or template filename when available.
   - Strip configured trailing suffixes such as version, draft/final, date, or
     internal author codes.
   - If the resulting title is not Korean, inspect the content and choose a
     concise Korean title before running the script with `--title`.
3. Resolve the author key from the user request or
   `share_outbox.default_author`; read the public suffix from
   `share_outbox.authors.<key>.suffix`.
4. Generate the filename with the configured template. Default shape:
   `{title}_{author}_{timestamp}{ext}`.
5. Copy the file into the configured outbox root and monthly folder. Default:
   `shared/YYYY-MM/`.
6. Append a local JSONL receipt to the configured receipt path. Default:
   `shared/_state/index.jsonl`.
7. Return the output path and receipt path to the user.

## Script

Use `scripts/prepare_share_file.py` with the workspace Python runtime for
deterministic filename generation, copying, duplicate protection, and receipt
writing.

Typical usage:

```bash
~/.anchor/env/.venv/bin/python ~/.anchor/skills/share-outbox/scripts/prepare_share_file.py /path/to/source.ext --title "한글 제목"
~/.anchor/env/.venv/bin/python ~/.anchor/skills/share-outbox/scripts/prepare_share_file.py /path/to/source.ext --inbox-item inbox/items/done/item-id
~/.anchor/env/.venv/bin/python ~/.anchor/skills/share-outbox/scripts/prepare_share_file.py /path/to/source.ext --dry-run
```

Rules:

- Do not overwrite an existing outgoing file unless the user explicitly asks to
  replace it.
- Do not assume an outbox is excluded because its folder is named `shared`.
  Workspace sync exclusions must come from runtime sync configuration.
- Do not embed personal values in this skill. Use `workspace.config.yaml`.
- Actual sending or upload belongs to provider skills such as `io-gws` or
  `io-mso`.

## References

- `references/workspace-config.md` - runtime configuration keys
- `references/filename-rules.md` - title and suffix replacement rules
