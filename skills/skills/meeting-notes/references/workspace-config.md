# Workspace Config

```yaml
meeting_notes:
  root: ~/workspace/work/meetings
  filename_template: "MM-DD {type} - {topic} - {detail}.md"
  guides:
    quick_start: _guides/QUICK_START.md
    glossary: _guides/GLOSSARY.md
    people: _guides/PEOPLE.md
  hooks:
    task_skill: task-management
    vault_extract_skill: vault-extract
    vault_connect_skill: vault-connect
```

The public skill must not store participant lists, private project names, or
workspace-specific account values.
