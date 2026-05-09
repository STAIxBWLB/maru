---
name: vault-rename
description: Safely rename a vault note and update all references across vault + extract/sync SKILL.md. Handles move_note + grep refs + batch patch_note + graph invalidate + log event in one atomic workflow.
trigger: /vault-rename
---

# /vault-rename [old-name] [new-name]

Atomic vault note rename with full reference propagation. Implements 2026-04-22 Rethink M7 (JSIF→JIUCC 사례의 18 파일 수동 patch 이슈 해소).

## Input
- **old-name**: existing note name (without `.md` extension), e.g. `jsif-aws-green-bio-amazon-rfp-consortium`
- **new-name**: new note name (without `.md` extension), e.g. `jiucc-aws-green-bio-amazon-rfp-consortium`

## When to invoke

- 네이밍 오타·정정 (정오자)
- Acronym 변경 (JSIF → JIUCC 같은 브랜드 정정)
- Scope 변경 (예: `rise-program` → `rise-y2-program`)
- Lint L10b registry hygiene 교체 과정에서 노트명 shift 필요 시

**Do NOT use for**: 내용 개편·분할·병합 (→ `/vault-refactor` 사용)

## Process

### Step 1: Pre-flight 검증

1. `mcp__obsidian__read_note old-name.md` — old note 존재 확인
2. `mcp__obsidian__read_note new-name.md` — new 이름 충돌 확인
   - 존재 시 ABORT, 사용자에게 보고 (merge 의도면 `/vault-refactor` 권고)
3. 변경 영향 범위 grep 수행 (Step 2 병행)

### Step 2: 참조 탐색 (vault + skill)

```bash
# vault 전체 참조 (wiki-link + frontmatter)
Search "{{old-name}}" in the configured vault path
# skill SKILL.md (work-side 방법론 문서)
Search "{{old-name}}" in the workspace skills directory
```

결과 파일 목록을 사용자에게 제시:
```
REFERENCES FOUND (N files)
  vault notes: [...]
  vault reports: [...]  (다음 /vault-graph build에서 자동 재생성 가능)
  ops/sessions: [...]
  skill files: [...]
```

### Step 3: Confirm (user approval gate — MANDATORY)

```
RENAME PROPOSAL
===============
old: notes/{{old}}.md
new: notes/{{new}}.md

References to patch: N files
- vault patches (MCP): M files
- skill patches (filesystem Edit): K files
- auto-regenerated on next /vault-graph build: reports/*.json, graph-report-*.md

Internal note updates:
- H1 title line
- description frontmatter (if contains old-name)

Accept: [y]es, [n]o
```

### Step 4: Execute (on accept)

1. **Rename note**: `mcp__obsidian__move_note(oldPath, newPath)`
2. **Internal updates**: patch_note on the renamed note for:
   - H1 line (`# old name` → `# new name`)
   - description if contains old-name
3. **Batch patch references** (vault, MCP):
   ```
   for each vault file with references:
     mcp__obsidian__patch_note(path, old-name, new-name, replaceAll: true)
   ```
4. **Batch patch references** (work/_sys/skills, filesystem):
   ```
   for each skill file with references:
     Edit(path, old-name, new-name, replace_all: true)
   ```
5. **Graph invalidation**: `reports/graph-report-*.md` + `reports/vault-graph.json` 정리 불필요, 다음 `/vault-graph build`에서 자동 재생성 — stale 여부는 L11이 7일 임계로 탐지

### Step 5: Verify

1. `Grep old-name` 재실행 — 잔여 매치 확인
2. **허용되는 잔여**:
   - `log.md` 내 이력 이벤트 (e.g. "old → new" 정정 기록)
   - `reports/vault-graph.json` (다음 build에서 재생성)
   - Meeting 원본 파일명 (`work/meetings/.../04-02 회의 - JSIF-AWS...md`) — 물리 파일명 변경은 별도 의사결정
3. **의도되지 않은 잔여 존재** → 사용자에게 보고 + 추가 패치 여부 확인

### Step 6: log.md LINT event append

```
YYYY-MM-DD HH:MM  LINT  -  notes/{{old}}.md → notes/{{new}}.md  — rename, N files updated
```

## Safety Rules

- **Move_note 실패 시 ABORT** — 참조 patch 단계 진입 금지
- **Patch 도중 일부 실패** → 성공분 기록 + 실패 목록 사용자 보고, 자동 롤백 없음 (감사 가능한 부분 진척 우선)
- **설치 스킬 인식**: `~/.claude/skills/` 및 `~/.codex/skills/`는 canonical `_sys/skills/skills/`를 가리키는 symlink 설치 대상이다. 편집은 canonical에서 수행한다.
- **vault 쓰기는 MCP Obsidian만** (notes/·reports/·ops/·log.md)
- **skill 파일은 Filesystem Edit** (`.claude/skills/`·`work/_sys/skills/`는 vault 외부)

## Quality Gates

- Move_note 성공 확인
- 참조 patch 성공률 ≥95% (5% 이내 skill·legacy 경로는 Step 5에서 사용자 확인)
- LINT event 기록
- Graph 재빌드 권장 (7일 내 `/vault-graph build`)

## Output

- Step 3 Proposal 블록
- Step 4 실행 결과 요약 (N files patched)
- Step 5 verify 결과 (잔여 매치 목록)
- Step 6 log append 확인

## Related

- **/vault-refactor** — 노트 내용 개편·분할·병합 (rename 이상의 구조적 변경)
- **/vault-graph build** — rename 후 7일 내 재빌드 권장
- **/vault-lint** — L11(graph stale) · L10(registry vault_note orphan) 연동
- 근거: 2026-04-22 Rethink M7 (ops/methodology/260422-rethink-report.md §T2)
