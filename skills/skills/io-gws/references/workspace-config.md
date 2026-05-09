# Workspace Config

```yaml
io:
  providers:
    gws:
      skill: io-gws
      enabled: true
      gws_binary: gws
      accounts: {}
      capabilities:
        - gmail.search
        - gmail.read
        - gmail.attachment_download
        - drive.search
        - drive.download
        - calendar.write
        - tasks.write
```

Concrete account aliases, calendar IDs, task list IDs, and Drive roots are
workspace-local values.
