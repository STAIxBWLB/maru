# Workspace Config

`inbox-process` expects the same `inbox` section used by `inbox-intake`, plus
optional hooks:

```yaml
inbox:
  root: ~/workspace/work/inbox
  paths:
    drop: drop
    items: items
    pending: items/pending
    done: items/done
    failed: items/failed
    duplicate: items/duplicate
    state: _state
    receipts: _state/index.jsonl
  naming:
    item_id_template: "{date}-{channel}-{slug}"
    raw_dir: raw
    manifest_file: manifest.yaml
    extracted_file: extracted.md
    summary_file: summary.md
    route_file: route.md
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

Processing must use `inbox.naming` for generated artifact names. Read manifests
from `manifest_file`; write extracted text, summaries, and route proposals to
the configured `extracted_file`, `summary_file`, and `route_file` inside each
item directory. Raw originals stay under `raw_dir`.

When invoked as `inbox-process <channel> [context...]`, `<channel>` must match
an `inbox.channels` root key. Remaining free text is processing context; tokens
with `key=value` shape are processing hints. These hints can influence summary
and route proposals, but they do not bypass route confirmation.
