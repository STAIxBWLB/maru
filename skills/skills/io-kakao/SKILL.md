---
name: io-kakao
description: >
  Public-safe KakaoTalk IO connector skill. Use for generic KakaoTalk message
  export, monitor output, attachment reference, relay send, and inbox-intake
  export workflows. Chat room names, local monitor config, and service secrets
  are workspace-local values only.
---

# IO Kakao

Provide KakaoTalk message/file intake primitives, queued outbound send, and
normalized inbox export.

Live messages flow through a dedicated-Mac relay (`maru-kakao-relay`) over a
synced folder; this skill never calls kmsg or KakaoTalk directly. The bus
layout and schemas are defined in `references/relay-layout.md`.

## Boot Sequence

1. Find `workspace.config.yaml`.
2. Read `io.providers.kakao` (including `relay_root`).
3. Verify the requested capability and configured monitor or export path.
4. For inbox imports, pass message batches and file references to
   `inbox-intake`.

## Capabilities

- message monitor output (relay bus `messages/` envelopes)
- export file intake
- attachment reference intake
- message send, queued (relay bus `outbox/pending/`, allowlist-gated)
- local notification handoff when configured

## Send (queued, relay)

Use `scripts/kakao_send.py` to enqueue a `kakao-send/v1` request; the
dedicated-Mac relay performs the actual send:

```bash
python3 scripts/kakao_send.py --work <workRoot> \
  --chat "<exact room name>" --text "message" [--attachment /path/to/file]
```

- Always confirm with the user before sending to other people.
- The room must be on the relay's `send_allowed` allowlist, and the relay's
  `send.enabled` switch must be on; otherwise the request comes back failed
  in `outbox/done/`.
- Check `outbox/done/<id>.json` for the result.

## Rules

- Store chat room names and local monitor settings only in workspace config or
  `.maru/secrets` (with `.secrets` kept only as a legacy compatibility symlink).
- Group related messages into one inbox item when they form one topic.
- Do not classify messages or create tasks directly; use `inbox-process`.
- Use file hashes when source-native message IDs are unavailable.

## References

- `references/workspace-config.md` - expected runtime provider keys
- `references/relay-layout.md` - relay bus tree, single-writer rule, schemas
