---
name: vault-rethink
trigger: /vault-rethink
description: Review accumulated observations and tensions for methodology evolution.
---

# /vault-rethink [mode]

Review observations, tensions, and methodology drift.

## Modes

- **review**: Process pending observations and tensions + aging check
- **drift**: Detect configuration drift from derivation
- **full**: Complete methodology review (review + drift + aging)

## Process

### review mode

1. **Observations 처리**: `ops/observations/` + `ops/tensions/` 파일 읽기 (MCP `read_multiple_notes`). `tensions/`는 첫 긴장 기록 전까지 디렉토리 자체가 없다 — 부재는 드리프트가 아니라 미사용 상태
2. **Patterns 식별**: methodology·process·friction·surprise·quality 5 카테고리 그룹핑
3. **Methodology changes 제안**: evidence 기반, `M{N}` ID 부여
4. **Decisions 기록**: `ops/methodology/YYMMDD-rethink-report.md`를 `mcp__obsidian__write_note`로 생성 (frontmatter + state snapshot + observations + tensions + proposed changes + drift check)

> 구 M4-2 인라인 태스크 aging check·cap 경고(`ops/reminders.md`, 200/500 임계)는 2026-05-05 인라인 태스크의 work `tasks/` 이관으로 retired. 측정 대상이 없으므로 단계에서 제거(2026-08-19).

### drift mode

1. **Config ↔ Derivation 일치**: `ops/derivation.md` **§Design Dimensions 표** ↔ `ops/config.yaml` `dimensions`(8키) + `domains`(6) 를 키별로 대조. 한쪽에만 있는 키도 mismatch. 출력은 키별 match/mismatch 표 + 최종 판정(예: "8/8 dimensions + 6/6 domains match")
2. **AGENTS.md consistency**: vault AGENTS.md·work AGENTS.md 규칙이 최신 methodology와 일치하는지
3. **Skill SKILL.md vs 실제 사용**: M1 (spec-practice audit)에 따라 아래 14종 중 하나를 순환 선택하여 audit — `vault-connect extract graph learn lint next pipeline refactor remember rename rethink stats sync update`
4. **Report deviations**: drift table (Check / Status / Action)

### full mode

Review + drift 모두 실행.

## Triggers

- 10+ unprocessed observations (`ops/config.yaml` `maintenance.rethink_observations_threshold`)
- 5+ unprocessed tensions

## Output

- Pattern analysis from observations
- Proposed methodology changes (M{N} IDs, never auto-applied)
- Decision record if changes accepted
- Drift table (item 1은 키별 verdict 포함)

## Rule Zero

Changes require explicit approval. This skill proposes, user decides.

## 관련

- `ops/methodology/260418-rethink-report.md` — M4 compaction 근거
- `ops/methodology/260422-rethink-report.md` — M4-2·M7 근거 (이번 라운드)
- `/vault-rename` 스킬 (M7, 2026-04-22 신설) — note rename 워크플로우
