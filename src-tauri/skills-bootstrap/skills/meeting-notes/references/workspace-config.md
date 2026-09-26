# Workspace Config

```yaml
meeting_notes:
  root: ~/workspace/work/meetings
  filename_template: "YYMMDD-meeting-{slug}.md"
  guides:
    quick_start: _guides/QUICK_START.md
    glossary: _guides/GLOSSARY.md
    people: _guides/PEOPLE.md
  hooks:
    task_skill: task-management
    vault_extract_skill: vault-extract
    vault_connect_skill: vault-connect
    enrichment: context   # optional: enable context-enrichment (entity resolution + bundle)
    verification: internal-external   # optional: enable content verification & supplementation (workflow step 5)
```

When `hooks.enrichment` is set, the skill also reads `ssot.context_enrichment`
and the `context.*` lookup paths (people/glossary fast caches plus the canonical
vault MOCs) to resolve entities and assemble the project context bundle before
drafting. See `_meta/rules/context-enrichment.md`.

When `hooks.verification` is set, the skill runs the content verification &
supplementation step (workflow step 5) before drafting: high-risk claims are
cross-checked against internal sources (vault, past meetings, tasks, registry)
and, as a last resort, web search under the context-enrichment §2-7 contract
(`web_unverified` + source URL, user-confirmed promotion only). Proposed
changes surface in the review block's `corrections` array; nothing is applied
silently. Absent hook means the step is skipped.

The skill also reads `io.providers` to pick a calendar command for the
work-schedule lookup (workflow step 3). Provider names are runtime values;
any of them may be absent, in which case the lookup is skipped and noted.

The public skill must not store participant lists, private project names, or
workspace-specific account values.
