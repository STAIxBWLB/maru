# Workspace Config

```yaml
io:
  providers:
    telegram:
      skill: io-telegram
      enabled: true
      secrets: {}
      capabilities:
        - message.scan
        - attachment.download
        - bot.notify
```

Tokens, chat IDs, room labels, and session files are workspace-local values.
