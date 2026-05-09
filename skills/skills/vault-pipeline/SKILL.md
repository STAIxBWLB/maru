---
name: vault-pipeline
trigger: /vault-pipeline
description: Run seed/register -> extract -> connect -> lint pipeline for vault inbox items or work sources
---

# /vault-pipeline [target]

> **When to use**: vault/inbox/에 이미 등록된 항목이나 신규 work/ 파일·디렉토리를 전체 파이프라인으로 처리.

Batch process inbox items or specified work targets through the full pipeline. This skill owns the old seed/batch orchestration surface; there is no separate seed or ralph skill.

> **Registry fallback**: when project registry scoring < 3 → content-based domain analysis → prompt user. SSOT: `<workspace-root>/_sys/rules/project-registry-scoring.md`

## Input
- target: `inbox`, a specific vault inbox item, a work file, or a work directory

## Process

1. Resolve targets:
   - `inbox` → list vault inbox items via Obsidian MCP
   - work file/directory → enumerate eligible source files and register source references for this run
2. Pre-classify all items via project registry:
   - Read workspace `project-registry.yaml` once (status: active only)
   - For each item: score signals (people +3, acronyms +2, keywords +2, orgs +1, tags +1), attach project + `vault_note`
   - Pass classification downstream to /vault-extract (prevents registry reload per item)
3. For each item:
   a. /vault-extract -- pull insights into notes
   b. /vault-connect -- find relationships for new notes
   c. /vault-lint note=<note> -- check quality of new notes
4. Move processed vault inbox references to vault/archive/ when applicable
5. Generate completion report

## Output
- Summary: items processed, notes created, connections made
- Quality: pass/fail counts from verify
- Remaining: inbox count after processing

## Guards
- Respects inbox WIP limit (20)
- Stops on critical errors, continues on warnings
