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
    enrichment: context   # optional: enable context-enrichment (entity resolution + bundle)
```

When `hooks.enrichment` is set, the skill also reads `ssot.context_enrichment`
and the `context.*` lookup paths (people/glossary fast caches plus the canonical
vault MOCs) to resolve entities and assemble the project context bundle before
drafting. See `_sys/rules/context-enrichment.md`.

The public skill must not store participant lists, private project names, or
workspace-specific account values.
