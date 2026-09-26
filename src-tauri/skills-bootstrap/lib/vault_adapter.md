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
   - `ssot.ingest_chain` (log TYPE set and normalization table)
3. If a key is missing, ask for the workspace-local value instead of hardcoding a personal path.

## Access Rules

### Vault Markdown

All vault `.md` writes, moves, deletes, frontmatter edits, and tag edits must go through Obsidian MCP tools — `notes/`, `ops/` (observations, methodology, sessions logs), and root docs alike. Agent-side reads and searches also go through MCP. Do not use filesystem write/edit or shell commands for vault markdown.

Three declared exceptions (machine I/O, not agent writes):

| Path | Writer / reader | Why |
|---|---|---|
| `log`, `ops/sessions/last-sync-timestamp` | fs read/append by any vault skill | plain files, not Obsidian notes |
| `reports/{vault-graph.json,workspace-graph.json,graph-report-*.md,graph-trend.md}` | written by `lib/build-graph.py` (fs) | machine-generated artifacts; `lint-YYMMDD.md` is still written via MCP |
| `notes/*.md` **read-only** | `lib/build-graph.py`, `vault-lint/scripts/lint.py` | deterministic scripts scan the tree; they never write notes |

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

Vault-changing workflows append one line to the configured vault log (`vault.log_file`) by **direct fs append** (`>>`) — the log is a plain logfile, not a note:

```text
YYYY-MM-DD HH:MM  TYPE  project  source → dest  — note
```

`TYPE` is workspace-defined (`ssot.ingest_chain`): the canonical set is `INGEST ROUTE EXTRACT CONNECT DIGEST LEARN LINT TASK GRAPH SYNC RETHINK SOURCE`; historical non-standard TYPEs are interpreted via that rule's normalization table and must not be written anew (structure changes such as rename/refactor log as `EXTRACT`).

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

**MOC enforcement on `topics`**: `topics` carries hub navigation only. Concept/keyword tags (e.g., `credit-recognition`, `partnership-mapping`, `duty-model`) belong in body text, not in `topics`. Skills must verify that each `[[target]]` in `topics` resolves to an existing note before promoting a summary to a vault note. If a needed MOC does not exist, create it first as a thin hub (`type: moc` + `description` + maru wiki-link), or replace the offending entry with an existing MOC. Never silently copy unknown wiki-links from summary.md into vault notes.

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
