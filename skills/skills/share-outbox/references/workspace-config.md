# Workspace Config

The skill discovers `workspace.config.yaml` by walking up from the current
directory. Public skill files must not store real owner suffixes, account IDs,
or workspace-only paths.

```yaml
share_outbox:
  root: ~/workspace/work/shared
  timezone: Region/City
  default_author: author_key
  authors:
    author_key:
      suffix: AUTHOR_SUFFIX
      name_ref: owner.name
  filename:
    template: "{title}_{author}_{timestamp}{ext}"
    timestamp_format: "%y%m%d-%H%M"
    suffix_patterns:
      - "(_|-)([A-Z]{2,12}|[0-9]{4,8}|v[0-9]+|draft|final)$"
  paths:
    monthly: "{yyyy}-{mm}"
    receipts: _state/index.jsonl
```

## Runtime Rules

- Expand `~` before using paths.
- `root` is the local staging root for outgoing copies.
- `authors.<key>.suffix` is the public filename suffix.
- `filename.template` must include `{title}`, `{author}`, `{timestamp}`, and
  `{ext}`.
- `paths.receipts` is relative to `root` unless absolute.
- If a required key is missing, stop before copying.
