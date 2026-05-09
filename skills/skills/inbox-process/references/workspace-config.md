# Workspace Config

`inbox-process` expects the same `inbox` section used by `inbox-intake`, plus
optional hooks:

```yaml
inbox:
  root: ~/workspace/work/inbox
  paths:
    drop: drop
    pending: items/pending
    done: items/done
    failed: items/failed
    duplicate: items/duplicate
    receipts: _state/index.jsonl
  channels:
    kakao:
      provider: kakao
      skill: io-kakao
      kind: bundle
      drop_paths: [drop/kakao]
      source_kinds:
        messages: message
        files: attachment
      dedupe: sha256
  processing:
    require_confirm_before_route: true
    summary_schema: inbox-summary/v1
  hooks:
    task_skill: task-management
    vault_extract_skill: vault-extract
    vault_connect_skill: vault-connect
    digest_output: _state/digests
```

Project classification must read the paths configured under `ssot`.

When invoked as `inbox-process <channel> [context...]`, `<channel>` must match
an `inbox.channels` root key. Remaining free text is processing context; tokens
with `key=value` shape are processing hints. These hints can influence summary
and route proposals, but they do not bypass route confirmation.
