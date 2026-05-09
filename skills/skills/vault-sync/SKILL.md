---
name: vault-sync
trigger: /vault-sync
description: Scan work/ for changes and propose vault extractions with confirmation
---

# /vault-sync [scope]

Scan work/ for new or changed content and propose vault extractions. Nothing is created without explicit user confirmation.

## Input
- scope (optional): "full" (all work/), "meetings" (meetings only), "projects" (projects only), "diff" (git diff only)
- Default: "full"

Raw recordings and unreviewed transcripts are not scanned by `/vault-sync`. Only refined meeting notes under `work/meetings/2026/2026-MM/` are considered vault-worthy sources. Any transcript provider output must be processed through `meeting-notes` first.

## Process

### Step 1: Scan

2-source parallel scan:

#### 1A: Meeting Notes (highest priority)
```bash
# List all meeting files in current month
ls <workspace-root>/meetings/2026/2026-MM/
```
- Cross-reference vault notes source fields to find unprocessed meetings
- Grep vault `notes/` for `source:.*work/meetings/2026/2026-MM` to identify already-extracted

#### 1B: Git Diff — Work Root + Submodules (NEW)
```bash
# Work root: changes since last sync timestamp
cd <workspace-root>
LAST_SYNC=$(cat <vault.path>/ops/sessions/last-sync-timestamp)
# Convert YYYYMMDDHHMI to git date format
SINCE_DATE=$(echo $LAST_SYNC | sed 's/\(....\)\(..\)\(..\)\(..\)\(..\)/\1-\2-\3 \4:\5/')

# Root repo changes (exclude system/meetings/tasks — those have dedicated scanners)
git log --oneline --since="$SINCE_DATE" --name-only -- . \
  ':!.omc' ':!.claude' ':!.obsidian' ':!meetings' ':!tasks' \
  | grep -v '^\w\{7\} ' | grep -v '^$' | grep -v '\.json$' \
  | grep -v '_sys/' | grep -v 'uv.lock' | grep -v 'pyproject.toml' \
  | sort -u

# Submodule changes: detect which submodules have new commits
git submodule status --recursive | grep '^+' | awk '{print $2}'
```

**Submodule change detection**:
- `+` prefix in `git submodule status` = submodule HEAD differs from recorded commit
- For each changed submodule, check its recent commits:
  ```bash
  cd <workspace-root>/$SUBMODULE
  git log --oneline --since="$SINCE_DATE" --name-only -- . ':!.omc' ':!.claude' \
    | grep -v '^\w\{7\} ' | grep -v '^$' | sort -u
  ```

**Work repo submodules (root + recursive, `.gitmodules` 기준)**:

| Category | Submodules | Vault-relevant |
|----------|-----------|----------------|
| projects/ | kbs-election | HIGH |
| teaching/ | course-repos (+ai-systems, +djgirls), halla-ai | MEDIUM |
| research/ | research | MEDIUM |
| meetings/ | meetings | (별도 스캐너) |
| personal/ | personal (+STAIxBWLB, +assets, +me) | LOW |
| dev/ | dev (+hwp-toolkit, +dotfiles, +rootfiles) | LOW |
| _sys/ | skills, skills-private, service submodules | SKIP |

Converted regular directories (`projects/rise/`, `projects/rise-research/`, `projects/oda-*`, `projects/ai-disaster/`, `teaching/courses/`) are covered by the root git diff scan, not submodule scan.

### Step 1.5: Filter & Classify

**Filter rules** (reduce noise):
- Skip: `_sys/`, `.json`, `uv.lock`, `pyproject.toml`, `*.css`, `*.js`, `*.html`
- Skip: draft versions if final exists (e.g., `drafts/260331-v2-*` if `final/260402-v4-*` exists)
- Skip: personal/, dev/ submodules unless explicitly requested
- Include: `README.md`, `*-plan-*.md`, `*-report-*.md`, `*-summary-*.md`, `*-strategy-*.md`
- Include: any `.md` in `admin/`, `external/`, `projects/collabs/`, `projects/govt/`

**Classify via project registry**:
1. Read `<workspace-root>/project-registry.yaml` (status: active only)
2. Extract signals from the candidate file (keywords, people, organizations, acronyms)
3. Score: people +3, acronyms +2, keywords +2, orgs +1, tags +1
4. top score >= 3 → attach project name + `vault_note` to proposal
5. Ambiguous → mark as "project: TBD (user confirm)"

> **Registry fallback**: score < 3 → content-based domain analysis → if still ambiguous, prompt user via disambiguation field. SSOT: `<workspace-root>/_sys/rules/project-registry-scoring.md`

**Deduplication** (multi-signal, 2026-04-16 revision):

1. **source field exact match**: `source: work/meetings/...` 경로 직접 일치
2. **Title similarity ≥70%**: fuzzy compare against vault note titles
3. **Recent update-section detection** (NEW): 대상 회의 날짜 헤더(`## Update (YYYY-MM-DD)` 또는 `## YYYY-MM-DD ...`)가 vault 노트에 이미 존재하면 "이미 반영됨"으로 판정
4. **Entity overlap** (보조): 회의 제목의 주요 인물·기관 키워드가 vault 노트 본문에 ≥3회 등장 시 후보

**판정 로직**:
- 1, 2, 3 중 **임의 하나 hit** → "already reflected — skip" 제안
- 1 miss + 2 hit (≥70%) → "update" 제안 (source field 갱신 포함)
- 모두 miss → "create" 제안

**근거 (2026-04-16 학습)**: /vault-sync가 04-14 회의 3건을 재추출 제안했으나 실제로는 vault 노트에 이미 반영됨. source field만 원본 경로를 가리키지 않아 dedup이 놓쳤음. update-section detection을 추가하여 content-level dedup 보완.

### Step 2: Propose

Present candidates grouped by source and priority:
```
EXTRACTION PROPOSALS
====================
Scanned: meetings 9건, git-diff 5건, submodules 2건

─── MEETINGS (HIGH) ───

[1] MEETING: 04-08 협력회의 - Diquest AI플랫폼
    -> Proposed: update [[diquest-ai-education-platform-mou]]
    -> Domain: projects

─── GIT DIFF (MEDIUM-HIGH) ───

[2] DIFF: admin/innovation/260405-org-restructuring.md (new file)
    -> Proposed: update [[chu-ai-headquarters-establishment-vp-level]]
    -> Domain: operations

[3] DIFF: projects/hope/10-planning/260403-plan-masterplan.md (new file)
    -> Proposed: update [[hope-tuition-free-global-online-degree-idea]]
    -> Domain: projects

─── SUBMODULE CHANGES ───

[4] SUBMODULE: projects/kbs-election (+3 commits)
    -> Changed: pipeline/, reports/
    -> Proposed: update [[kbs-election-ai-pipeline]]
    -> Domain: projects

[5] SUBMODULE: teaching/halla-ai (+1 commit)
    -> Changed: src/pages/
    -> Proposed: update [[halla-ai-department-home]]
    -> Domain: teaching

Accept: [a]ll, [1-5] select, [s]kip, [q]uit
```

### Step 3: Confirm
- User selects which proposals to execute
- For each confirmed proposal:
  1. Read the source document fully
  2. Extract insights per /vault-extract methodology
  3. Create vault note(s)
  4. Update relevant MOCs
  5. Show created note for review

### Step 3.5: R4 Sibling Merge — Method Evidence 자동 갱신 (M10, 2026-04-24 도입)

이번 세션에서 **R4 sibling merge**가 1건 이상 실행된 경우 (≥2 meetings → 1 노트 merge), `sibling-meeting-merge-n-to-one-consolidation-method` 노트의 evidence 테이블을 자동 갱신한다.

**절차**:
1. 이번 /vault-sync 라운드에서 수행한 R4 merge 노트 목록 수집 (target note + merged sessions count)
2. `mcp__obsidian__read_note('notes/sibling-meeting-merge-n-to-one-consolidation-method.md')` 호출
3. `## 실증 사례 (3건, YYYY-MM-DD 기준)` 테이블에서 해당 merged 노트 행 찾기
4. **누적 N 증가**: `N = 기존 N + 이번 라운드 병합 수`
5. **날짜 분포 append**: `기존 분포 + MM-DD(N추가)` 형태로 append
6. `mcp__obsidian__patch_note`로 테이블 갱신
7. 신규 merged 노트(케이스 추가)인 경우 **새 행** 추가

**근거**: 2026-04-24 Rethink O2 — 4라운드 누적 method evidence drift (기록 N=5, 실제 N=13) 해소

**Skip 조건**:
- R4 merge 0건인 세션 → Step 3.5 skip
- User가 /vault-sync --skip-method-update 플래그 사용 시

### Step 4: Record
- Update last-sync timestamp in ops/sessions/last-sync-timestamp
- Log sync results in ops/sessions/YYYYMMDD-sync.md

## Scope Details

### /vault-sync meetings
- Scan work/meetings/2026/ for notes not yet in vault
- Cross-reference vault notes source fields
- Extract: decisions, insights, relationship updates

### /vault-sync projects
- Git diff on work root + project submodules
- Scan work/projects/ README and key doc changes
- Compare with existing vault project notes
- Propose updates to existing notes or new notes

### /vault-sync diff
- Git diff only (skip meeting scanners)
- Work root + all submodules
- Useful for catching project doc changes between meeting-heavy days

### /vault-sync full
- All of the above in priority order: meetings → git diff → submodules
- Limit: max 10 proposals per run (avoid overwhelm)
- Raw recordings and transcripts must be refined into `work/meetings/` first

## Quality Gates
- Same as /vault-extract quality gates
- Additional: deduplication check before creation
- Confirmation required for every note creation

## Output
- Summary of scan results (per source: meetings, diff, submodules)
- Numbered proposals with accept/skip interface
- After execution: list of created/updated notes
- Updated sync timestamp
