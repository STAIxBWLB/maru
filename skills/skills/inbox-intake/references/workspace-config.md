# Workspace Config

The skill discovers `workspace.config.yaml` by walking up from the current
directory. Public skill files must not store real account values.

```yaml
inbox:
  root: ~/workspace/work/inbox
  schema_version: 1
  paths:
    drop: drop
    items: items
    pending: items/pending
    done: items/done
    failed: items/failed
    duplicate: items/duplicate
    state: _state
    receipts: _state/index.jsonl
  dedupe:
    default: sha256
  channels:
    kakao:
      provider: kakao
      skill: io-kakao
      kind: bundle
      drop_paths: [drop/kakao]
      source_kinds:
        messages: message
        files: attachment
        exports: data
      dedupe: sha256
    arc:
      provider: local
      kind: file
      drop_paths: [drop/arc]
      dedupe: sha256
    mso:
      provider: mso
      skill: io-mso
      kind: bundle
      drop_paths: [drop/mso]
      source_kinds:
        mail: message
        sharepoint: document
      dedupe: provider-native
```

Provider runtime values live under `io.providers`.

`inbox.channels` keys are the channel names accepted by
`inbox-process <channel>`. Keep user-facing calls on the root channel (`mso`, `gws`,
`telegram`, `kakao`, `arc`, etc.); treat provider subfolders as
`metadata.source_kind` hints.
