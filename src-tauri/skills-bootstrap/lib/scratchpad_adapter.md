---
name: scratchpad_adapter
description: Scratchpad path contract for skills that read or write workspace scratchpad collections. Skills resolve the root and subdirectory names from workspace.config.yaml instead of hardcoding scratchpad/ literals.
type: spec
---

# Scratchpad Adapter Rules

## Purpose

Shared path contract for skills that touch the workspace scratchpad. Policy
document, not a Python module.

Every other workspace collection declares its own root (`inbox.root`,
`meeting_notes.root`, `task_management.root`, `share_outbox.root`) and skills
resolve through it. The scratchpad was the exception: its config keys existed
but only `lib/build-graph.py` read them, so skills wrote `scratchpad/...`
literals that silently ignore a relocated or renamed collection.

## Runtime Discovery

1. Find `workspace.config.yaml` by walking up from the current working
   directory.
2. Read these keys:

```yaml
paths:
  scratchpad: ~/workspace/work/scratchpad   # collection root
scratchpad:
  ideation_subdir: ideation
  memos_subdir: memos
  drafts_subdir: drafts
  temp_subdir: temp
  editable_extensions: [md, markdown, txt]
  editable_max_bytes: 2097152
  temp_stale_days: 7
  ideation_review_days: 90
```

3. Compose paths as `<paths.scratchpad>/<scratchpad.*_subdir>`. Never join a
   literal `scratchpad/` segment.
4. When a key is absent, fall back to the subdirectory name shown above. When
   `paths.scratchpad` is absent, fall back to `scratchpad` relative to the
   workspace root.

## Collections

| Key | Default | Holds |
|---|---|---|
| `ideation_subdir` | `ideation` | Idea seeds, one idea per file, under `seeds/` |
| `memos_subdir` | `memos` | Raw originals: dictation, long unscoped memos |
| `drafts_subdir` | `drafts` | Reviewable document drafts |
| `temp_subdir` | `temp` | Working files; excluded from git and cloud sync |

## Rules

- Resolve, never hardcode. A skill that writes `scratchpad/drafts/` is wrong
  even when that is the current value.
- Do not introduce a second key for a path this section already names. A skill
  needing the ideation collection reads `scratchpad.ideation_subdir`; it does
  not declare its own `*_target` key pointing at the same directory.
- Thresholds are config too. `temp_stale_days`, `ideation_review_days`, and
  `editable_max_bytes` are the authority for staleness and size checks; do not
  restate the numbers in skill prose.
- `temp_subdir` is excluded from git and cloud sync. Nothing durable goes
  there.
- Writing into the scratchpad still obeys each skill's own write surface. This
  spec resolves paths; it does not grant permission to write to them.
