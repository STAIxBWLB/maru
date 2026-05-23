---
name: vault_adapter
description: Vault access rules for public vault-facing skills. Skills discover paths from workspace.config.yaml and use Obsidian MCP for vault markdown.
type: spec
---

# Vault Adapter Rules

## Purpose

This spec is the shared access contract for vault-facing skills. It is a policy document, not a Python module.

## Runtime Discovery

At the start of a vault-facing workflow:

1. Find `workspace.config.yaml` by walking up from the current working directory.
2. Read these keys when present:
   - `vault.path`
   - `vault.log_file`
   - `ssot.project_registry`
   - `ssot.rules`
   - `ssot.glossary`
   - `ssot.people`
   - `skills.vault_adapter`
3. If a key is missing, ask for the workspace-local value instead of hardcoding a personal path.

## Access Rules

### Vault Markdown

All vault `.md` reads, writes, moves, deletes, frontmatter edits, tag edits, and searches must go through Obsidian MCP tools. Do not use filesystem read/write/edit or shell commands for vault markdown.

Typical mappings:

| Operation | Tool family |
|---|---|
| Read note | `mcp__obsidian__read_note`, `read_multiple_notes` |
| Search/list | `mcp__obsidian__search_notes`, `list_directory` |
| Create/update | `mcp__obsidian__write_note`, `patch_note`, `update_frontmatter` |
| Move/delete | `mcp__obsidian__move_note`, `move_file`, `delete_note` |
| Tags/stats | `mcp__obsidian__manage_tags`, `list_all_tags`, `get_vault_stats` |

### Workspace SSOT

Workspace-local operational files are not vault markdown. They may be read or edited through normal filesystem tools:

- `workspace.config.yaml`
- `project-registry.yaml`
- files under the workspace rules directory
- skill source files in this repo

## Log Append

Vault-changing workflows append one line to the configured vault log through Obsidian MCP:

```text
YYYY-MM-DD HH:MM  TYPE  project  source -> dest  - note
```

Allowed `TYPE` values are workspace-defined; common values are `INGEST`, `ROUTE`, `EXTRACT`, `CONNECT`, `DIGEST`, `LEARN`, `LINT`, `TASK`, and `GRAPH`.

## Summary To Vault Fields

When promoting a source summary into a vault note, copy source-derived fields instead of regenerating them:

| Vault note field | Source summary field | Rule |
|---|---|---|
| `description` | `description` | Required, non-empty, concise |
| `domain` | `domain` | Required, workspace-defined domain enum |
| `topics` | `topics` | Required, at least one wiki link, **and every `[[target]]` must already exist as a MOC note in vault** (MOC = note where `type: moc` or a domain hub like `projects.md`, `research.md`, `operations.md`, `teaching.md`, `people.md`, `ai-practice.md`). |
| `source` | `source` | Preserve source identity |
| `project` | `project` | Map via project registry when available |

If required fields are missing, fail before writing. Do not synthesize blank or guessed values.

**MOC enforcement on `topics`**: `topics` carries hub navigation only. Concept/keyword tags (e.g., `credit-recognition`, `partnership-mapping`, `duty-model`) belong in body text, not in `topics`. Skills must verify that each `[[target]]` in `topics` resolves to an existing note before promoting a summary to a vault note. If a needed MOC does not exist, create it first as a thin hub (`type: moc` + `description` + anchor wiki-link), or replace the offending entry with an existing MOC. Never silently copy unknown wiki-links from summary.md into vault notes.

## Project Registry Pattern

1. Load `ssot.project_registry` from `workspace.config.yaml`.
2. Score workspace-defined signals such as people, acronyms, keywords, orgs, and tags.
3. Use a clear match when the top score passes the workspace threshold.
4. If ambiguous, use registry disambiguation fields or ask the user.
5. If still unresolved, record the source as unclassified and continue only when the calling workflow allows it.

## Boundary

- Work files: filesystem tools.
- Vault markdown: Obsidian MCP only.
- Cloud mirrors or synced copies: do not edit directly from vault skills.
