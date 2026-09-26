---
name: vault-pipeline
trigger: /vault-pipeline
description: Run extract -> connect -> lint pipeline over a batch of work/ sources
---

# /vault-pipeline [target]

> **When to use**: work/ 파일·디렉토리 여러 건을 extract → connect → lint 전체 파이프라인으로 일괄 처리. 단건은 `/vault-extract` 직접 호출.

Batch process work targets through the full pipeline. work `inbox/` 항목은 먼저 `inbox-process`로 summary를 만든 뒤 그 산출물을 대상으로 삼는다(vault는 inbox를 갖지 않는다).

> **Registry fallback**: when project registry scoring < 3 → content-based domain analysis → prompt user. SSOT: `<workspace-root>/_meta/rules/project-registry-scoring.md`

## Input
- target: a work file, a work directory, or an explicit list of work paths

## Process

1. Resolve targets: enumerate eligible source files (`.md` with frontmatter or summary output) for this run
2. Pre-classify all items via project registry:
   - Read workspace `project-registry.yaml` once (status: active only)
   - For each item: score signals (people +3, acronyms +2, keywords +2, orgs +1, tags +1), attach project + `vault_note`
   - Pass classification downstream to /vault-extract (prevents registry reload per item)
3. For each item:
   a. /vault-extract -- pull insights into notes
   b. /vault-connect -- find relationships for new notes
   c. /vault-lint note=<note> -- check quality of new notes
4. Generate completion report

## Output
- Summary: items processed, notes created, connections made
- Quality: per-note `/vault-lint note=` error/warn counts
- Remaining: targets skipped (precondition failures, see vault-extract §Preconditions)

## Guards
- Max 20 targets per run (collector's-fallacy guard; split larger batches)
- Stops on critical errors, continues on warnings
