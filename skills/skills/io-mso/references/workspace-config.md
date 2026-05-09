# Workspace Config

```yaml
io:
  providers:
    mso:
      skill: io-mso
      enabled: true
      auth_mode: workspace-local
      command: m365
      accounts: {}
      secrets: {}
      capabilities:
        - mail.search
        - mail.read
        - mail.draft
        - mail.send
        - sharepoint.search
        - sharepoint.download
```

Account labels, tenant details, auth status paths, and secrets references are
workspace-local values. Do not copy them into the public skill package.
