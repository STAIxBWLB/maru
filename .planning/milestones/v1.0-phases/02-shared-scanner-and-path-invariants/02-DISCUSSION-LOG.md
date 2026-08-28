# Phase 2: Shared Scanner and Path Invariants - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-23
**Phase:** 2-shared-scanner-and-path-invariants
**Areas discussed:** Module placement, Union membership, Canonical example, SCAN-04 guard

---

## Module placement

| Option | Description | Selected |
|--------|-------------|----------|
| New paths.rs | src-tauri/src/paths.rs 신규 모듈. 신규 author에게 'the one place'가 이름에서 바로 드러남. 기존 모듈 책임 오염 없음 | ✓ |
| Widen workspace_files.rs | pub(crate) → pub로만 변경. 가장 짧은 경로지만 scanner 모듈이 path-containment의 canonical home이 되는 게 어색 | |
| vault.rs | resolve_inside_vault/lexical_normalize 옆에 배치. 다만 vault는 스캐너 모듈이라 공유 유틸 홈으로는 혼재 | |

**User's choice:** New paths.rs
**Notes:** Co-location follow-up: GENERATED_DIRS + ensure_within + join guard 모두 한 모듈에 (One module 선택).

---

## Union membership

| Option | Description | Selected |
|--------|-------------|----------|
| Full union, all five | 14개 항목의 단일 GENERATED_DIRS. SCAN-01 'one-line edit, all five pick it up'에 정확히 부합. 예외 분기 재발 방지 | ✓ |
| Core + per-scanner extras | 공통 core 상수 + 스캐너별 추가 상수. secrets만 .pnpm-store 같은 케이스를 보존하지만 '한 곳' 원칙이 약해짐 | |

**User's choice:** Full union, all five
**Notes:** evidence_binder widening follow-up: 4-entry matches!도 14개 union으로 확장 승인 (Yes, widen it).

---

## Canonical example

| Option | Description | Selected |
|--------|-------------|----------|
| Doc + tests only | 모듈 doc에 사용 예시 + unit test로 시연. retrofit 리스크 0 | ✓ |
| Convert 1-2 callers | 낮은 리스크 caller 1~2개 전환해 실제 예시 제공. ParentDir 매칭과 starts_with 검사는 의미가 달라 미세한 동작 변화 수반 | |
| Opportunistic | 지금은 doc/test만, 이후 해당 모듈을 건드릴 때 전환하는 규칙을 doc에 명시 | |

**User's choice:** Doc + tests only
**Notes:** Component::ParentDir / substring ".." / starts_with 검사가 동등하지 않다는 CONCERNS.md 지적이 결정적 근거.

---

## SCAN-04 guard

| Option | Description | Selected |
|--------|-------------|----------|
| Return Err | 기존 명령들이 Result<T, String>를 반환하는 컨벤션과 일치. 릴리스에서도 안전하게 실패 | ✓ |
| assert!/panic | 프로그래머 에러로 간주, 즉시 크래시. 릴리스 앱 크래시는 UX상 최악 | |
| debug_assert! | dev/test에서만 터짐. 릴리스는 무방비 — 재발 방지 guard로는 약함 | |

**User's choice:** Return Err
**Notes:** Guard site follow-up: maru_home()/install_root_base() 내부에서 반환 전 is_absolute 검증 (Inside maru_home() 선택) — 모든 join site를 한 곳에서 커버.

---

## Claude's Discretion

- Unit-test shape, fixture layout, per-scanner rewiring mechanics (planner-owned)
- ensure_within error message generalization (".maru directory" wording)

## Deferred Ideas

None — discussion stayed within phase scope.
