---
name: io-kakao
description: >
  Public-safe KakaoTalk IO connector skill. Use for generic KakaoTalk message
  export, monitor output, attachment reference, and inbox-intake export
  workflows. Chat room names, local monitor config, and service secrets are
  workspace-local values only.
---

# IO Kakao

Provide KakaoTalk message/file intake primitives and normalized inbox export.

## Boot Sequence

1. Find `workspace.config.yaml`.
2. Read `io.providers.kakao`.
3. Verify the requested capability and configured monitor or export path.
4. For inbox imports, pass message batches and file references to
   `inbox-intake`.

## Capabilities

- message monitor output
- export file intake
- attachment reference intake
- local notification handoff when configured

## Rules

- Store chat room names and local monitor settings only in workspace config or
  `.secrets`.
- Group related messages into one inbox item when they form one topic.
- Do not classify messages or create tasks directly; use `inbox-process`.
- Use file hashes when source-native message IDs are unavailable.

## References

- `references/workspace-config.md` - expected runtime provider keys
