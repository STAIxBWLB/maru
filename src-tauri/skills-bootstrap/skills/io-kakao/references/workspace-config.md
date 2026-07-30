# Workspace Config

```yaml
io:
  providers:
    kakao:
      skill: io-kakao
      enabled: true
      relay_root: ~/Dropbox/work/inbox/kakao-bridge
      secrets: {}
      capabilities:
        - message.scan
        - attachment.reference
        - export.import
        - message.send
```

- `relay_root` - synced folder shared with the dedicated-Mac relay. See
  `references/relay-layout.md` for the bus contract.
- `message.send` - queued outbound send via `outbox/pending/`; gated by the
  relay's `send.enabled` switch and per-room `send_allowed` allowlist.

Chat room names, monitor config paths, and local service state are
workspace-local values.
