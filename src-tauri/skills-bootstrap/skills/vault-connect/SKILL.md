---
name: vault-connect
trigger: /vault-connect
description: Find and create wiki link connections between vault notes
---

# /vault-connect [note]

Find relationships between a note and existing vault notes, create wiki links.

## Input
- note: filename or path of a note in vault/notes/
- entities_hint (optional): list of 인물/기관 names from source summary.md — used as wiki-link candidate seeds in step 2 first pass

## Process

0. **Graph Report + Smart Connections 사전 조회** (있으면):
   a. `vault/reports/graph-report-YYMMDD.md`가 7일 이내 존재 시 읽기 → 대상 노트의 community 소속 확인, surprising connections 중 미연결 항목 우선 연결 후보로 설정
   b. Obsidian Smart Connections 플러그인이 활성 상태면 대상 노트의 semantic neighbors 상위 5개를 추가 연결 후보로 포함 (키워드 매칭으로 놓치는 cross-domain 연결 보완)
   c. 위 후보를 Step 2의 검색 결과와 병합 (중복 제거)
1. Read the target note completely
2. Search vault/notes/ for related notes by:
   - **entities_hint first pass** (if provided): for each entity name, search `glossary.md`, `people.md`, and vault/notes/ titles for exact or fuzzy matches. These are highest-priority link candidates since they're pre-identified by summaries or source metadata.
   - **Backref seeds** (if present in target frontmatter): `relatedMeetings`, `relatedTasks`, `source_doc` / `meetingSourcePath` (context-enrichment §4) are pre-identified origins — treat their resolved `[[targets]]` as high-priority bidirectional link candidates.
   - Title keyword matching
   - Description similarity
   - Shared topics/MOCs
   - Same domain or cross-domain relevance
   - Project affinity via registry: if source is from work/, read `<workspace-root>/project-registry.yaml` to identify project, then prioritize sibling notes sharing the same `vault_note` topic as connection candidates

> **Registry fallback**: when project registry scoring < 3 → content-based similarity → prompt user. SSOT: `<workspace-root>/_sys/rules/project-registry-scoring.md`
3. For each discovered relationship:
   - Determine relationship type (supports, contradicts, extends, applies-to, context-for)
   - Add wiki link to both notes (bidirectional)
   - Include relationship context after the link
4. Update relevant MOCs if new connections span topics
5. **Append CONNECT event to vault/log** (ingest chain audit trail)
6. Report connections made and any cross-domain patterns discovered

## Log Append (Step 5 — REQUIRED)

Every /vault-connect invocation that creates ≥1 wiki link must produce one `log` line. `vault/log` is a plain logfile (no extension): append via direct fs write (`>>`), the sole exception to MCP-only vault writes.

**Format** (see `<workspace-root>/_sys/rules/ingest-chain.md` §"vault/log 포맷"):

```
YYYY-MM-DD HH:MM  CONNECT  <project>  <vault/notes/x.md>  — linked `[[a]]`, `[[b]]`, `[[c]]`
```

- `<project>`: project id from the target note's source registry classification, or `-` if unclassified
- `<vault/notes/x.md>`: target note being connected
- "linked target list": list of newly created wiki-link targets (cap at 5; if more, use overflow style with "+N more" suffix)

**No connections made**: do not append (zero-link runs are silent). Report zero-connection runs in chat output instead.

**Bidirectional links**: one log line for the target note (forward direction). Backlink updates to other notes do not create additional log lines — they are implied.

**Failure**: if any wiki-link write fails, log the successful portion and warn user.

**Vault access**: MCP Obsidian only.

## Quality Gates

- Every connection must have stated reasoning
- Bidirectional: if A links to B, B should link to A
- Don't force connections — quality over quantity
- **CONNECT event appended to log for every run with ≥1 link created**

## Output
- List of connections made with reasoning
- Cross-domain patterns noted (if any)
- Updated MOCs (if any)
- log append status
