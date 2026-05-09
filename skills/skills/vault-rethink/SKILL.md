---
name: vault-rethink
trigger: /vault-rethink
description: Review accumulated observations and tensions for methodology evolution. Runs aging check on reminders.md (M4-2 2026-04-22) as part of review flow.
---

# /vault-rethink [mode]

Review observations, tensions, and methodology drift.

## Modes

- **review**: Process pending observations and tensions + aging check
- **drift**: Detect configuration drift from derivation
- **full**: Complete methodology review (review + drift + aging)

## Process

### review mode

1. **Aging check (inline-tasks.md)** — M4-2 (2026-04-22)
   - Read `<workspace-root>/tasks/inline-tasks.md` `## Active Tasks` 섹션 (work-local)
   - 각 task line에서 `➕ YYYY-MM-DD` (dateCreated) 추출
   - 현재 날짜 - dateCreated > 90일인 항목 식별
   - **자동 expired 제안 블록** 생성:
     ```
     AGING EXPIRED PROPOSAL (N items, 90+ days)
     =========================================
     [1] [카테고리] 내용 ➕ YYYY-MM-DD (N일 경과)
         → 제안: `- [x] ... ❌ YYYY-MM-DD expired (aged 90+d)`
     [2] ...
     Accept: [a]ll, [1-N] select, [s]kip
     ```
   - User confirm 시 batch 이동 → `## Archived Tasks §Aging Expired` 섹션
   - skip 시 rethink report `Decisions` 섹션에 "aged skipped"로 기록
2. **Inline cap 경고** — M4-2 (2026-04-22)
   - `## Active Tasks` 미완료 카운트
   - 200 초과 → report에 soft 경고 + task file 승격 권장 후보 (서브태스크 ≥2 추출)
   - 500 초과 → hard 리셋 필요 flag (M4 compaction 재실행 권고)
3. **Observations 처리**: ops/observations/ + ops/tensions/ 파일 읽기
4. **Patterns 식별**: methodology·process·friction·surprise·quality 5 카테고리 그룹핑
5. **Methodology changes 제안**: evidence 기반, `M{N}` ID 부여
6. **Decisions 기록**: ops/methodology/YYMMDD-rethink-report.md (frontmatter + state snapshot + observations + tensions + proposed changes + drift check)

### drift mode

1. **Config ↔ Derivation 일치**: `ops/config.yaml` vs `ops/derivation.md` 비교
2. **CLAUDE.md consistency**: vault CLAUDE.md·work CLAUDE.md 규칙이 최신 methodology와 일치하는지
3. **Skill SKILL.md vs 실제 사용**: M1 (spec-practice audit)에 따라 순환 스킬 하나 선택하여 audit
4. **Report deviations**: drift table (Check / Status / Action)

### full mode

Review + drift + aging 모두 실행.

## Triggers

- 10+ unprocessed observations
- 5+ unprocessed tensions
- Session orient hook suggests when thresholds met
- **Reminders Active 500건 재도달** (자동 T1 trigger)

## Output

- Pattern analysis from observations
- Aging expired proposal (M4-2)
- Proposed methodology changes (M{N} IDs, never auto-applied)
- Decision record if changes accepted
- Drift table

## Rule Zero

Changes require explicit approval. This skill proposes, user decides.

**Single exception (M4-2)**: reminders.md 200 soft 경고는 report에 기록만 (non-blocking). 500 hard 리셋은 별도 compaction 제안 블록으로 승격.

## 관련

- `ops/methodology/260418-rethink-report.md` — M4 compaction 근거
- `ops/methodology/260422-rethink-report.md` — M4-2·M7 근거 (이번 라운드)
- `/vault-rename` 스킬 (M7, 2026-04-22 신설) — note rename 워크플로우
