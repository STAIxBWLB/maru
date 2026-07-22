---
name: vault-refactor
trigger: /vault-refactor
description: Restructure notes, split/merge, improve titles, reorganize MOCs (with mandatory approval gate)
---

# /vault-refactor [target]

Restructure vault content for better organization. **Never auto-executes** — always presents a structured plan and waits for explicit user approval.

## Operations

- **split [note]**: Break a note into multiple atomic notes
- **merge [note1] [note2]**: Combine related notes
- **rename [note]**: Improve note title (prose-as-title)
- **moc [domain]**: Reorganize a domain MOC
- **promote [topic]**: Create topic MOC from tag cluster (20+ notes threshold)

## Process

1. Analyze target for refactoring opportunity
2. **Present approval gate** (see format below)
3. On explicit accept → execute
4. Update all affected wiki links via `mcp__obsidian__patch_note` (bidirectional)
5. Run `/vault-lint note=<path>` on each affected note
6. Append `CONNECT` event to `log` for each wiki-link update batch
7. Commit changes (via auto-commit hook or user `/commit`)

## Approval Gate Format

Before any write, present this block to the user:

```
REFACTOR PROPOSAL
=================
operation: split | merge | rename | moc | promote
target: <path or note name>

plan:
  - action 1: <describe — source path → dest path>
  - action 2: <describe>
  - ...

affected notes: <count> (<list if ≤10>)
affected wiki-links: <count>
broken link risk: <low | medium | high>
reversibility: <easy | hard — explain why>

side effects:
  - <MOC updates>
  - <glossary mentions>
  - <task file impacts>

Accept: [y]es, [n]o, [d]etails, [m]odify
```

**Non-negotiable**: Do not write anything until the user explicitly says `y` or equivalent. `m` opens iteration — re-plan and re-present. `d` shows full affected list.

## Vault Access

**MCP Obsidian only** for all reads and writes:
- `mcp__obsidian__read_note` / `read_multiple_notes`
- `mcp__obsidian__write_note` for new notes
- `mcp__obsidian__patch_note` for targeted edits (preferred for link updates)
- `mcp__obsidian__move_note` for renames
- `mcp__obsidian__delete_note` for deletions (requires confirmPath)

Filesystem access (Read/Write/Edit/Bash) is forbidden on vault paths.

## Log Append

For each refactor batch that modifies ≥1 note, append one `CONNECT` event to `log`:

```
YYYY-MM-DD HH:MM  CONNECT  -  refactor:<operation>  — <summary> (N notes, M links)
```

- `<operation>`: split | merge | rename | moc | promote
- `<summary>`: one-line describing the change

Each individual wiki-link update does not get its own log line — one line per refactor batch is sufficient.

## Guards

- **NEVER auto-execute** — approval gate is mandatory
- All wiki links must be updated (no broken links after)
- Bidirectional links maintained
- MOC references updated
- If any step fails, attempt rollback via `patch_note` reverse edits; if rollback fails, log `— failed: <reason>` and stop

## Output

- Proposed changes with reasoning (approval gate block)
- On accept: execution report (per-note status)
- Verify results for all affected notes
- log append confirmation
