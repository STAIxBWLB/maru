# Workspace Config

```yaml
io:
  providers:
    kakao:
      skill: io-kakao
      enabled: true
      secrets: {}
      capabilities:
        - message.scan
        - attachment.reference
        - export.import
```

Chat room names, monitor config paths, and local service state are
workspace-local values.
