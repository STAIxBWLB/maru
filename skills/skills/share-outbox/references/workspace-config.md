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
  telegram:
    enabled: false
```

## Runtime Rules

- Expand `~` before using paths.
- `root` is the local staging root for outgoing copies.
- `authors.<key>.suffix` is the public filename suffix.
- `filename.template` must include `{title}`, `{author}`, `{timestamp}`, and
  `{ext}`.
- `paths.receipts` is relative to `root` unless absolute.
- If a required key is missing, stop before copying.
- `telegram.enabled` (optional, default false) turns on Telegram auto-send of
  the staged copy. Bot credentials are read from the file referenced by
  `io.providers.telegram.secrets.monitor_config`
  (`notification.telegram.bot_token` / `chat_id`); no credentials live under
  `share_outbox`.
