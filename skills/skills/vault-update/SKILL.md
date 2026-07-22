---
name: vault-update
trigger: /vault-update
description: Refresh an outdated note with new context while preserving core insight (MCP Obsidian only)
---

# /vault-update [note]

Update a note with new information while preserving original meaning.

## Input
- note: filename or path in `notes/`

## Process

1. Read target note via `mcp__obsidian__read_note`
2. Identify what's changed (new context, superseded info, additional evidence)
3. Draft the update:
   - preserve core insight
   - add new content in an explicit section (e.g., `## Update YYYY-MM-DD`) OR inline-revise with preservation
4. Apply via MCP Obsidian:
   - minor edit → `mcp__obsidian__patch_note(path, oldString, newString)`
   - major rewrite → `mcp__obsidian__write_note(path, content, mode: "overwrite")`
   - frontmatter change → `mcp__obsidian__update_frontmatter(path, frontmatter)`
5. Check connected notes (via `mcp__obsidian__search_notes` for wiki-link targets); propose cascading updates if needed
6. Record update in note body (timestamp or changelog line)
7. Run `/vault-lint note=<path>` on updated note
8. Append `CONNECT` event to `log` if wiki-links changed, or skip log if only body/frontmatter touched

## Vault Access

**MCP Obsidian only**. No filesystem Read/Write/Edit on vault paths. Use:

| Operation | MCP Tool |
|-----------|---------|
| Read | `mcp__obsidian__read_note` |
| Full rewrite | `mcp__obsidian__write_note(mode: "overwrite")` |
| Append | `mcp__obsidian__write_note(mode: "append")` |
| Targeted edit | `mcp__obsidian__patch_note` |
| Frontmatter | `mcp__obsidian__update_frontmatter` |
| Tags | `mcp__obsidian__manage_tags` |
| Search for impact | `mcp__obsidian__search_notes` |

## Quality Gates

- Original insight must be preserved OR explicitly superseded with `status: superseded` frontmatter + link to replacement note
- All existing wiki-links must remain valid
- New wiki-links added where relevant
- Changelog/timestamp line appended to body when content changes materially

## Log Append

If wiki-links or MOC membership changed, append:

```
YYYY-MM-DD HH:MM  CONNECT  <project>  notes/<note>.md  — updated: <summary>
```

If only body text or frontmatter changed (no link impact), **do not append** — /vault-update is not an ingest chain stage, so body-only edits stay silent.

## Output

- Summary of changes made
- Connected notes reviewed (and any cascading proposals)
- note-level `/vault-lint` result
- log append status (if applicable)
